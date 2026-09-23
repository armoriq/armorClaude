"use strict";
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
