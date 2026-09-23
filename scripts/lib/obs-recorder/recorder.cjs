"use strict";
/**
 * ObservabilityRecorder — in-memory ring buffer for traces + spans.
 *
 * The recorder is the only place in the SDK that mints trace/span IDs. The
 * session chokepoints (peer subagent's wrap) call `startTrace` /
 * `recordPolicyCall` / `endTrace` and the recorder takes care of:
 *   1. Validating each emit (cheap shape checks; bad data is logged + dropped,
 *      never thrown into the SDK consumer).
 *   2. Minting IDs and computing endTime/durationMs.
 *   3. Holding the in-memory ring buffer (default 1000 traces). On overflow,
 *      the oldest trace AND all its spans are dropped (we never want a partial
 *      trace at the backend).
 *   4. Pushing ended traces onto the shipper's queue.
 *   5. Forwarding every emit to the test sink (if set) so tests can assert
 *      on the exact lifecycle.
 *
 * Per plan §9 Q3: in-memory only. `durable: true` is parsed and stored but
 * does nothing in v1 — a one-time warning is logged the first time a
 * consumer opts in.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservabilityRecorder = void 0;
exports.__setObservabilitySinkForTests = __setObservabilitySinkForTests;
const shipper_1 = require("./shipper.cjs");
const schema_1 = require("./schema.cjs");
const model_prices_1 = require("./model-prices.cjs");
const trace_summary_1 = require("./trace-summary.cjs");
const DEFAULT_MAX_BUFFER = 1000;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_BATCH_SIZE = 100;
let currentSink = null;
function __setObservabilitySinkForTests(sink) {
    currentSink = sink;
}
function notifySink(event) {
    if (currentSink) {
        try {
            currentSink(event);
        }
        catch (e) {
            // A throwing sink is a test bug. Log and continue — never let test
            // plumbing break the SDK consumer.
            // eslint-disable-next-line no-console
            console.warn(`[observability] test sink threw: ${e?.message ?? e}`);
        }
    }
}
let durableWarned = false;
// ─── Recorder ─────────────────────────────────────────────────────────────
class ObservabilityRecorder {
    enabled;
    product;
    userId;
    agentId;
    defaultSessionId;
    maxBufferSize;
    onSpan;
    buffer = [];
    bufferIndex = new Map();
    shipper;
    warnedDurable = false;
    constructor(config) {
        this.enabled = config.enabled !== false;
        this.product = config.product;
        this.userId = config.userId ?? null;
        this.agentId = config.agentId ?? null;
        this.defaultSessionId = config.sessionId ?? null;
        this.maxBufferSize = config.maxBufferSize ?? DEFAULT_MAX_BUFFER;
        this.onSpan = config.onSpan;
        if (config.durable && !durableWarned) {
            durableWarned = true;
            this.warnedDurable = true;
            // eslint-disable-next-line no-console
            console.warn('[observability] durable=true is parsed but not implemented in v1; ' +
                'spans are held in memory only and lost on process exit');
        }
        this.shipper = new shipper_1.ObservabilityShipper({
            endpoint: config.endpoint,
            apiKey: config.apiKey,
            product: this.product,
            sessionId: this.defaultSessionId,
            batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
            flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
            httpClient: config.httpClient,
        });
        if (this.enabled) {
            this.shipper.start();
        }
    }
    /** Internal accessor for tests; not part of the public API. */
    get __shipper() {
        return this.shipper;
    }
    /** True when the consumer passed `enabled: true` (the default). */
    get isEnabled() {
        return this.enabled;
    }
    // ─── Trace lifecycle ──────────────────────────────────────────────────
    /**
     * Mint a new trace and return its context. The trace is added to the
     * in-memory buffer (dropping the oldest if at capacity) and the context
     * is passed to subsequent `recordSpan` / `endTrace` calls.
     */
    startTrace(name, attributes, sessionId) {
        // Explicit `sessionId` (even explicit `null`) wins; otherwise fall back
        // to the recorder's default (the owning ArmorIQSession's stable UUID
        // session id). This is the single chokepoint that stamps sessionId onto
        // every trace uniformly, including callers (e.g. summarizeTranscriptUsage)
        // that don't pass one at all.
        const resolvedSessionId = sessionId !== undefined ? sessionId : this.defaultSessionId;
        if (!this.enabled) {
            // Return a no-op context. recordSpan/endTrace will be no-ops.
            return {
                traceId: (0, schema_1.mintId)(),
                sessionId: resolvedSessionId,
                name,
                startTimeMs: Date.now(),
                attributes: attributes ?? {},
            };
        }
        const traceId = (0, schema_1.mintId)();
        const startTimeMs = Date.now();
        const trace = {
            id: traceId,
            sessionId: resolvedSessionId,
            name,
            startTime: new Date(startTimeMs).toISOString(),
            endTime: null,
            durationMs: null,
            status: 'ok',
            userId: this.userId,
            agentId: this.agentId,
            attributes: attributes ?? {},
            tags: [],
        };
        this.appendToBuffer({ trace, spans: [] });
        notifySink({ kind: 'trace_started', trace, sessionId: trace.sessionId });
        return {
            traceId,
            sessionId: trace.sessionId,
            name,
            startTimeMs,
            attributes: trace.attributes,
        };
    }
    /**
     * Append a span to an existing trace. The span is validated against the
     * wire schema; an invalid span is logged and dropped (never thrown).
     */
    recordSpan(ctx, span) {
        if (!this.enabled)
            return;
        if (!(0, schema_1.isValidSpanRecord)(span)) {
            const spanAny = span;
            const kindLabel = spanAny?.kind ?? 'unknown';
            // eslint-disable-next-line no-console
            console.warn(`[observability] dropping invalid span (kind=${String(kindLabel)}, trace=${ctx.traceId})`);
            return;
        }
        const entry = this.bufferIndex.get(ctx.traceId);
        if (!entry) {
            // eslint-disable-next-line no-console
            console.warn(`[observability] recordSpan called for unknown traceId=${ctx.traceId}; dropping span`);
            return;
        }
        entry.spans.push(span);
        if (this.onSpan) {
            try {
                this.onSpan(span);
            }
            catch (e) {
                // eslint-disable-next-line no-console
                console.warn(`[observability] onSpan hook threw: ${e?.message ?? e}`);
            }
        }
        notifySink({
            kind: 'span_recorded',
            traceId: ctx.traceId,
            traceSessionId: entry.trace.sessionId,
            span,
        });
    }
    /**
     * Construct a `kind: 'policy_call'` span from the supplied fields and
     * record it under the given trace. Returns the constructed span (useful
     * for tests); otherwise the return value can be ignored.
     */
    recordPolicyCall(ctx, attrs, parentSpanId) {
        const span = {
            id: (0, schema_1.mintId)(),
            parentSpanId: parentSpanId ?? null,
            sessionId: ctx.sessionId,
            kind: 'policy_call',
            name: `${attrs.policyName ?? attrs.policyId ?? 'policy'}.${attrs.decision}`,
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: attrs.durationMs != null && Number.isFinite(attrs.durationMs)
                ? Math.round(attrs.durationMs)
                : 0,
            status: attrs.decision === 'allow' ? 'ok' : 'denied',
            attributes: {
                kind: 'policy_call',
                policyId: attrs.policyId,
                policyName: attrs.policyName,
                policyHash: attrs.policyHash ?? null,
                policyVersion: attrs.policyVersion ?? null,
                decision: attrs.decision,
                matchedRuleId: attrs.matchedRuleId ?? null,
                dataClasses: attrs.dataClasses ?? [],
                reason: attrs.reason,
                input: attrs.input,
                output: attrs.output,
                source: attrs.source,
                enforcementAction: attrs.enforcementAction ?? null,
                obligations: attrs.obligations ?? null,
                delegationId: attrs.delegationId ?? null,
            },
        };
        this.recordSpan(ctx, span);
        return span;
    }
    /**
     * Construct a `kind: 'generation'` span from the supplied fields,
     * compute `costUsd` from the static price table, and record it.
     * Unknown models yield costUsd=0 (the span is still recorded).
     * Pass `costUsd` to override the computed value (e.g. when the caller
     * already has a precomputed cost from a third-party billing system).
     */
    recordGeneration(ctx, attrs, parentSpanId) {
        const cost = attrs.costUsd ??
            (0, model_prices_1.computeCostUsd)(attrs.model, attrs.inputTokens, attrs.outputTokens, attrs.cacheReadTokens ?? 0, attrs.cacheWriteTokens ?? 0);
        const span = {
            id: (0, schema_1.mintId)(),
            parentSpanId: parentSpanId ?? null,
            sessionId: ctx.sessionId,
            kind: 'generation',
            name: `generation.${attrs.model}`,
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 0,
            status: 'ok',
            attributes: {
                kind: 'generation',
                model: attrs.model,
                inputTokens: attrs.inputTokens,
                outputTokens: attrs.outputTokens,
                cacheReadTokens: attrs.cacheReadTokens ?? null,
                cacheWriteTokens: attrs.cacheWriteTokens ?? null,
                costUsd: cost,
                prompt: attrs.prompt ?? null,
                completion: attrs.completion ?? null,
                finishReason: attrs.finishReason ?? null,
            },
        };
        this.recordSpan(ctx, span);
        return span;
    }
    /**
     * Record a `kind: 'event'` span — a point-in-time annotation (e.g.
     * "plan growth", "approval polled"). Use sparingly; events are cheap
     * but they still count toward the ring buffer.
     */
    recordEvent(ctx, attrs, parentSpanId) {
        const span = {
            id: (0, schema_1.mintId)(),
            parentSpanId: parentSpanId ?? null,
            sessionId: ctx.sessionId,
            kind: 'event',
            name: attrs.message.slice(0, 120),
            startTime: new Date().toISOString(),
            endTime: new Date().toISOString(),
            durationMs: 0,
            status: 'ok',
            attributes: {
                kind: 'event',
                message: attrs.message,
                level: attrs.level ?? 'info',
            },
        };
        this.recordSpan(ctx, span);
        return span;
    }
    /**
     * Mint + record a `kind: 'span'` CONTAINER span — a nesting point that
     * groups the child spans emitted by one chokepoint (e.g. `iap.enforce.local`)
     * under the session's single active plan trace (Model A: trace-per-plan).
     *
     * The container starts open (`status: 'ok'`, `endTime: null`,
     * `durationMs: null`) and MUST be finalized with `closeSpan()` once the
     * chokepoint's work completes (success or error). A container span with a
     * null `endTime` is intentionally valid mid-flight — see
     * `isValidGenericSpanAttributes`/`isValidSpanRecord`, which permit a
     * null `endTime`/`durationMs` for exactly this reason (Task 1 risk #1).
     *
     * Returns the minted span id — even when the recorder is disabled, so
     * call sites can pass it along unconditionally as a `parentSpanId` to
     * `recordPolicyCall`/`recordGeneration`/`recordEvent` without special-casing
     * the disabled path.
     */
    openSpan(ctx, opts) {
        const id = (0, schema_1.mintId)();
        if (!this.enabled)
            return id;
        const span = {
            id,
            parentSpanId: opts.parentSpanId ?? null,
            sessionId: ctx.sessionId,
            kind: 'span',
            name: opts.name,
            startTime: new Date().toISOString(),
            endTime: null,
            durationMs: null,
            status: 'ok',
            attributes: { kind: 'span', ...(opts.attributes ?? {}) },
        };
        this.recordSpan(ctx, span);
        return id;
    }
    /**
     * Finalize a container span previously opened with `openSpan()`: sets
     * `endTime`, optionally `durationMs`/`status`/`attributes.errorMessage`.
     * No-op (never throws) when the recorder is disabled, the trace is
     * unknown, or the spanId doesn't match a buffered span (e.g. it already
     * shipped) — mirrors `endTrace`'s defensive lookup.
     */
    closeSpan(ctx, spanId, opts) {
        if (!this.enabled)
            return;
        const entry = this.bufferIndex.get(ctx.traceId);
        if (!entry)
            return;
        const span = entry.spans.find((s) => s.id === spanId);
        if (!span)
            return;
        span.endTime = new Date().toISOString();
        if (opts?.durationMs != null && Number.isFinite(opts.durationMs)) {
            span.durationMs = Math.round(opts.durationMs);
        }
        if (opts?.status)
            span.status = opts.status;
        if (opts?.errorMessage !== undefined) {
            span.attributes = { ...span.attributes, errorMessage: opts.errorMessage };
        }
    }
    /**
     * Finalize a trace: set endTime, compute durationMs, apply optional
     * status / errorMessage. Pushes the (trace, spans) batch to the
     * shipper's queue, then REMOVES the entry from the in-memory ring buffer
     * — once a trace has been handed to the shipper, the shipper's own queue
     * is the durable record; keeping a second copy in the ring buffer would
     * let ended/shipped traces occupy buffer slots until overflow/flush,
     * needlessly evicting still-in-flight traces sooner. No-op when disabled
     * or when the trace is unknown.
     */
    endTrace(ctx, opts) {
        if (!this.enabled)
            return;
        const entry = this.bufferIndex.get(ctx.traceId);
        if (!entry) {
            // eslint-disable-next-line no-console
            console.warn(`[observability] endTrace called for unknown traceId=${ctx.traceId}; dropping`);
            return;
        }
        const endMs = Date.now();
        const durationMs = endMs - ctx.startTimeMs;
        const finalStatus = opts?.status ?? 'ok';
        const attributesWithError = opts?.errorMessage !== undefined
            ? { ...entry.trace.attributes, errorMessage: opts.errorMessage }
            : entry.trace.attributes;
        // Derive dashboard tags + an output summary from the trace's own spans
        // (policy_call decisions, tool names) — this is the one place every
        // trace passes through before shipping, so it's the natural chokepoint
        // to fill in `tags`/`attributes.output` for callers that never set them
        // explicitly. A caller-supplied non-empty `tags` array or an explicit
        // `attributes.output` always wins; this only fills genuine gaps.
        const summary = (0, trace_summary_1.deriveTraceSummary)(entry.spans, this.product);
        const updated = {
            ...entry.trace,
            endTime: new Date(endMs).toISOString(),
            durationMs,
            status: finalStatus,
            tags: entry.trace.tags.length > 0 ? entry.trace.tags : summary.tags,
            attributes: attributesWithError.output !== undefined || summary.output === null
                ? attributesWithError
                : { ...attributesWithError, output: summary.output },
        };
        // Enqueue the ended batch on the shipper — this is now the durable
        // record of the trace.
        this.shipper.enqueue({
            trace: updated,
            spans: entry.spans.slice(),
        });
        // Remove the entry from the ring buffer; it no longer needs to occupy a
        // buffer slot now that the shipper owns it.
        const idx = this.buffer.indexOf(entry);
        if (idx >= 0)
            this.buffer.splice(idx, 1);
        this.bufferIndex.delete(ctx.traceId);
        notifySink({
            kind: 'trace_ended',
            trace: updated,
            spans: entry.spans.slice(),
        });
    }
    // ─── Buffer management ────────────────────────────────────────────────
    /**
     * Drain the in-memory buffer. Returns a readonly array of the current
     * (trace, spans) pairs. The buffer is NOT cleared by this call — that
     * is `flush()`'s job. `drain()` is for inspection (tests, debugging).
     *
     * Note: since `endTrace()` removes entries once they're handed to the
     * shipper (see #8), `drain()` only ever reflects traces that are still
     * in-flight (started but not yet ended).
     */
    drain() {
        return this.buffer.map((e) => ({ trace: e.trace, spans: e.spans.slice() }));
    }
    /**
     * POST any queued (ended) batches via the shipper. Returns the shipper's
     * accepted/rejected counts. NEVER throws — observability failures must
     * not break the SDK consumer.
     *
     * Only ended traces (`trace.endTime !== null`) are ever handed to the
     * shipper (see `endTrace()`); in-flight (un-ended) traces stay in the
     * in-memory ring buffer untouched — flushing must never drop a trace
     * that's still being built. As an extra safety net (in case some future
     * caller enqueues directly), any buffer entries whose trace happens to
     * already carry an `endTime` are also handed to the shipper and removed
     * here; anything without an `endTime` is left alone and a warning is
     * logged with the retained count.
     */
    async flush() {
        if (!this.enabled)
            return { accepted: 0, rejected: 0 };
        const ended = this.buffer.filter((e) => e.trace.endTime !== null);
        if (ended.length > 0) {
            for (const entry of ended) {
                this.shipper.enqueue({ trace: entry.trace, spans: entry.spans.slice() });
                const idx = this.buffer.indexOf(entry);
                if (idx >= 0)
                    this.buffer.splice(idx, 1);
                this.bufferIndex.delete(entry.trace.id);
            }
        }
        const inFlightCount = this.buffer.length;
        if (inFlightCount > 0) {
            // eslint-disable-next-line no-console
            console.warn(`[observability] flush() retained ${inFlightCount} in-flight (un-ended) trace(s) in the buffer`);
        }
        return this.shipper.flush();
    }
    /**
     * Stop the underlying shipper (clears the periodic interval + final
     * flush). Call on session close. Safe to call multiple times.
     */
    async stop() {
        await this.shipper.stop();
    }
    // ─── Internals ────────────────────────────────────────────────────────
    appendToBuffer(entry) {
        this.buffer.push(entry);
        this.bufferIndex.set(entry.trace.id, entry);
        if (this.buffer.length > this.maxBufferSize) {
            const dropped = this.buffer.shift();
            if (dropped) {
                this.bufferIndex.delete(dropped.trace.id);
                // eslint-disable-next-line no-console
                console.warn(`[observability] ring buffer full (max=${this.maxBufferSize}); dropped trace=${dropped.trace.id}`);
            }
        }
    }
}
exports.ObservabilityRecorder = ObservabilityRecorder;
