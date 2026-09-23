"use strict";
/**
 * Standalone helper API for the chokepoints.
 *
 * The session chokepoints (in `src/session.ts`, owned by the peer subagent)
 * call these helpers instead of going through `ObservabilityRecorder` methods
 * directly. The wrapper signature is uniform:
 *
 *   const ctx = startTrace(obs, 'iap.enforce', { toolName });
 *   recordPolicyCall(obs, ctx, { ... });
 *   endTrace(obs, ctx, { status: 'ok' });
 *
 * All helpers are thin pass-throughs to the recorder — they're the
 * stable interface the chokepoints can import without needing to know
 * about the recorder's internal class shape.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startTrace = startTrace;
exports.recordSpan = recordSpan;
exports.recordPolicyCall = recordPolicyCall;
exports.recordGeneration = recordGeneration;
exports.recordEvent = recordEvent;
exports.openSpan = openSpan;
exports.closeSpan = closeSpan;
exports.endTrace = endTrace;
exports.flushObservability = flushObservability;
function startTrace(recorder, name, attributes, sessionId) {
    return recorder.startTrace(name, attributes, sessionId);
}
function recordSpan(recorder, ctx, span) {
    recorder.recordSpan(ctx, span);
}
function recordPolicyCall(recorder, ctx, attrs, parentSpanId) {
    return recorder.recordPolicyCall(ctx, attrs, parentSpanId);
}
function recordGeneration(recorder, ctx, attrs, parentSpanId) {
    return recorder.recordGeneration(ctx, attrs, parentSpanId);
}
function recordEvent(recorder, ctx, attrs, parentSpanId) {
    return recorder.recordEvent(ctx, attrs, parentSpanId);
}
function openSpan(recorder, ctx, opts) {
    return recorder.openSpan(ctx, opts);
}
function closeSpan(recorder, ctx, spanId, opts) {
    recorder.closeSpan(ctx, spanId, opts);
}
function endTrace(recorder, ctx, opts) {
    recorder.endTrace(ctx, opts);
}
async function flushObservability(recorder) {
    await recorder.flush();
}
