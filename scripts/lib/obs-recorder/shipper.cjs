"use strict";
/**
 * ObservabilityShipper — batches ended traces + their spans and POSTs them
 * to the backend ingest endpoint.
 *
 * Failure handling (the no-throw invariant):
 *   - 4xx: log warning, drop the batches. The backend has rejected the
 *     payload as malformed; retrying won't help.
 *   - 5xx and network errors: exponential backoff (500ms, 1s, 2s) up to
 *     3 retries; then log warning, drop.
 *   - Any throw from the httpClient is caught and treated as a network
 *     error (retried per the same schedule).
 *
 * The shipper is owned by `ObservabilityRecorder` — SDK consumers should
 * not construct it directly. It's exported so the recorder module can
 * import it without circular dep issues.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ObservabilityShipper = void 0;
const axios_1 = __importDefault(require("axios"));
const crypto_1 = require("crypto");
const schema_1 = require("./schema.cjs");
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const HTTP_TIMEOUT_MS = 10000;
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Split `batches` into chunks of at most `size` batches each (size >= 1). */
function chunkBatches(batches, size) {
    const effectiveSize = size > 0 ? size : DEFAULT_BATCH_SIZE;
    const chunks = [];
    for (let i = 0; i < batches.length; i += effectiveSize) {
        chunks.push(batches.slice(i, i + effectiveSize));
    }
    return chunks;
}
// ─── beforeExit singleton ──────────────────────────────────────────────────
// Each shipper registers itself here on start(). A single beforeExit listener
// drains all active shippers so we never leak listeners (Node warns at 11).
const activeShippers = new Set();
let beforeExitRegistered = false;
function registerBeforeExitHandler() {
    if (beforeExitRegistered)
        return;
    if (typeof process === 'undefined' || typeof process.on !== 'function')
        return;
    beforeExitRegistered = true;
    process.on('beforeExit', () => {
        for (const s of activeShippers) {
            void s.stop();
        }
    });
}
class ObservabilityShipper {
    endpoint;
    apiKey;
    product;
    sessionId;
    batchSize;
    flushIntervalMs;
    httpClient;
    queue = [];
    intervalHandle = null;
    stopPromise = null;
    constructor(config) {
        this.endpoint = config.endpoint.replace(/\/+$/, '');
        this.apiKey = config.apiKey;
        this.product = config.product;
        this.sessionId = config.sessionId ?? null;
        this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
        this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
        this.httpClient =
            config.httpClient ?? axios_1.default.create({ timeout: HTTP_TIMEOUT_MS });
    }
    /**
     * Append a batch to the internal queue. The shipper does not validate
     * the batch here (the recorder already validates on record); invalid
     * batches are filtered at flush time.
     */
    enqueue(batch) {
        this.queue.push(batch);
    }
    /**
     * Start the periodic auto-flush. Idempotent — calling start() while
     * already running is a no-op.
     */
    start() {
        if (this.intervalHandle)
            return;
        this.intervalHandle = setInterval(() => {
            void this.flush();
        }, this.flushIntervalMs);
        if (typeof this.intervalHandle === 'object' && this.intervalHandle !== null) {
            // Don't keep the event loop alive solely for the flush interval.
            this.intervalHandle.unref?.();
        }
        activeShippers.add(this);
        registerBeforeExitHandler();
    }
    /**
     * Stop the periodic auto-flush and do a final flush of anything still
     * in the queue. Safe to call multiple times.
     */
    stop() {
        if (this.stopPromise)
            return this.stopPromise;
        activeShippers.delete(this);
        this.stopPromise = (async () => {
            if (this.intervalHandle) {
                clearInterval(this.intervalHandle);
                this.intervalHandle = null;
            }
            await this.flush();
        })();
        return this.stopPromise;
    }
    /**
     * POST all queued batches, chunked so each POST carries at most
     * `this.batchSize` batches (default 100) — a burst of traces no longer
     * sends one unbounded giant POST. Chunks are sent sequentially (simpler
     * failure semantics than parallel: a failing chunk doesn't race with a
     * later chunk's retry backoff). Returns the summed `{ accepted, rejected }`
     * across all chunks. NEVER throws — observability failures must not break
     * the consumer.
     */
    async flush() {
        if (this.queue.length === 0) {
            return { accepted: 0, rejected: 0 };
        }
        // Snapshot the queue and clear it before the network call so a
        // concurrent enqueue lands in the next flush.
        const batches = this.queue.splice(0, this.queue.length);
        const valid = batches.filter((b) => (0, schema_1.isValidIngestBatch)(b));
        const invalid = batches.length - valid.length;
        if (invalid > 0) {
            // eslint-disable-next-line no-console
            console.warn(`[observability] shipper dropped ${invalid} invalid batch(es) at flush`);
        }
        if (valid.length === 0) {
            return { accepted: 0, rejected: invalid };
        }
        let accepted = 0;
        let rejected = invalid;
        for (const chunk of chunkBatches(valid, this.batchSize)) {
            const payload = {
                product: this.product,
                sessionId: this.sessionId,
                batches: chunk,
            };
            const result = await this.postWithRetry(payload);
            accepted += result.accepted;
            rejected += result.rejected;
        }
        return { accepted, rejected };
    }
    /** Test-only accessor: inspect the current queue size. */
    get __queueSize() {
        return this.queue.length;
    }
    // ─── Internals ────────────────────────────────────────────────────────
    async postWithRetry(payload) {
        const url = `${this.endpoint}/observability/spans`;
        const headers = {
            'X-API-Key': this.apiKey,
            'Content-Type': 'application/json',
            'X-Request-Id': (0, crypto_1.randomUUID)(),
        };
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const response = await this.httpClient.post(url, payload, { headers });
                const status = response.status;
                if (status >= 200 && status < 300) {
                    const data = (response.data ?? {});
                    return {
                        accepted: typeof data.accepted === 'number' ? data.accepted : 0,
                        rejected: typeof data.rejected === 'number' ? data.rejected : 0,
                    };
                }
                if (status >= 400 && status < 500) {
                    // eslint-disable-next-line no-console
                    console.warn(`[observability] shipper got ${status} from ${url}; dropping ${payload.batches.length} batch(es)`);
                    return { accepted: 0, rejected: payload.batches.length };
                }
                lastError = new Error(`HTTP ${status}`);
            }
            catch (e) {
                lastError = e;
            }
            if (attempt < MAX_RETRIES) {
                await sleep(BACKOFF_BASE_MS * 2 ** attempt);
            }
        }
        // eslint-disable-next-line no-console
        console.warn(`[observability] shipper failed after ${MAX_RETRIES} retries; dropping ${payload.batches.length} batch(es): ${lastError?.message ?? 'unknown error'}`);
        return { accepted: 0, rejected: payload.batches.length };
    }
}
exports.ObservabilityShipper = ObservabilityShipper;
