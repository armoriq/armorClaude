"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservabilityRecorder = void 0;
exports.__setObservabilitySinkForTests = __setObservabilitySinkForTests;
const shipper_1 = require("./shipper.cjs");
const schema_1 = require("./schema.cjs");
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
            console.warn(`[observability] test sink threw: ${e?.message ?? e}`);
        }
    }
}
let durableWarned = false;
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
    get __shipper() {
        return this.shipper;
    }
    get isEnabled() {
        return this.enabled;
    }
    startTrace(name, attributes, sessionId) {
        const resolvedSessionId = sessionId !== undefined ? sessionId : this.defaultSessionId;
        if (!this.enabled) {
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
    recordSpan(ctx, span) {
        if (!this.enabled)
            return;
        if (!(0, schema_1.isValidSpanRecord)(span)) {
            const spanAny = span;
            const kindLabel = spanAny?.kind ?? 'unknown';
            console.warn(`[observability] dropping invalid span (kind=${String(kindLabel)}, trace=${ctx.traceId})`);
            return;
        }
        const entry = this.bufferIndex.get(ctx.traceId);
        if (!entry) {
            console.warn(`[observability] recordSpan called for unknown traceId=${ctx.traceId}; dropping span`);
            return;
        }
        entry.spans.push(span);
        if (this.onSpan) {
            try {
                this.onSpan(span);
            }
            catch (e) {
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
    recordGeneration(ctx, attrs, parentSpanId) {
        const cost = attrs.costUsd ?? 0;
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
    endTrace(ctx, opts) {
        if (!this.enabled)
            return;
        const entry = this.bufferIndex.get(ctx.traceId);
        if (!entry) {
            console.warn(`[observability] endTrace called for unknown traceId=${ctx.traceId}; dropping`);
            return;
        }
        const endMs = Date.now();
        const durationMs = endMs - ctx.startTimeMs;
        const finalStatus = opts?.status ?? 'ok';
        const attributesWithError = opts?.errorMessage !== undefined
            ? { ...entry.trace.attributes, errorMessage: opts.errorMessage }
            : entry.trace.attributes;
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
        this.shipper.enqueue({
            trace: updated,
            spans: entry.spans.slice(),
        });
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
    drain() {
        return this.buffer.map((e) => ({ trace: e.trace, spans: e.spans.slice() }));
    }
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
            console.warn(`[observability] flush() retained ${inFlightCount} in-flight (un-ended) trace(s) in the buffer`);
        }
        return this.shipper.flush();
    }
    async stop() {
        await this.shipper.stop();
    }
    appendToBuffer(entry) {
        this.buffer.push(entry);
        this.bufferIndex.set(entry.trace.id, entry);
        if (this.buffer.length > this.maxBufferSize) {
            const dropped = this.buffer.shift();
            if (dropped) {
                this.bufferIndex.delete(dropped.trace.id);
                console.warn(`[observability] ring buffer full (max=${this.maxBufferSize}); dropped trace=${dropped.trace.id}`);
            }
        }
    }
}
exports.ObservabilityRecorder = ObservabilityRecorder;
