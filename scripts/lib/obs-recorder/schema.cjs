"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidSpanStatus = isValidSpanStatus;
exports.isValidSpanKind = isValidSpanKind;
exports.isValidPolicyDecision = isValidPolicyDecision;
exports.isValidPolicySource = isValidPolicySource;
exports.isValidPolicyEnforcementAction = isValidPolicyEnforcementAction;
exports.isValidEventLevel = isValidEventLevel;
exports.isValidGenericSpanAttributes = isValidGenericSpanAttributes;
exports.isValidPolicyCallAttributes = isValidPolicyCallAttributes;
exports.isValidGenerationAttributes = isValidGenerationAttributes;
exports.isValidEventAttributes = isValidEventAttributes;
exports.isValidSpanAttributes = isValidSpanAttributes;
exports.isValidTraceRecord = isValidTraceRecord;
exports.isValidSpanRecord = isValidSpanRecord;
exports.isValidIngestBatch = isValidIngestBatch;
exports.isValidIngestPayload = isValidIngestPayload;
exports.mintId = mintId;
exports.isValidUuid = isValidUuid;
const crypto_1 = require("crypto");
const SPAN_KINDS = new Set([
    'span',
    'policy_call',
    'generation',
    'event',
]);
const SPAN_STATUSES = new Set(['ok', 'error', 'denied']);
const POLICY_DECISIONS = new Set([
    'allow',
    'deny',
    'hold',
    'ask',
]);
const POLICY_SOURCES = new Set([
    'native',
    'sdk-local',
    'sdk',
    'proxy',
    'opa',
    'opa_fallback',
]);
const POLICY_ENFORCEMENT_ACTIONS = new Set([
    'allow',
    'allow_log',
    'hold',
    'block',
]);
const EVENT_LEVELS = new Set(['info', 'warn', 'error']);
function isPlainObject(x) {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isValidSpanStatus(x) {
    return typeof x === 'string' && SPAN_STATUSES.has(x);
}
function isValidSpanKind(x) {
    return typeof x === 'string' && SPAN_KINDS.has(x);
}
function isValidPolicyDecision(x) {
    return typeof x === 'string' && POLICY_DECISIONS.has(x);
}
function isValidPolicySource(x) {
    return typeof x === 'string' && POLICY_SOURCES.has(x);
}
function isValidPolicyEnforcementAction(x) {
    return (typeof x === 'string' && POLICY_ENFORCEMENT_ACTIONS.has(x));
}
function isValidEventLevel(x) {
    return typeof x === 'string' && EVENT_LEVELS.has(x);
}
function isStringOrNull(x) {
    return x === null || typeof x === 'string';
}
function isStringArrayOrEmpty(x) {
    return Array.isArray(x) && x.every((v) => typeof v === 'string');
}
function isValidGenericSpanAttributes(x) {
    if (!isPlainObject(x))
        return false;
    if (x.kind !== 'span')
        return false;
    if ('toolName' in x &&
        x.toolName !== undefined &&
        typeof x.toolName !== 'string')
        return false;
    if ('errorMessage' in x &&
        x.errorMessage !== undefined &&
        typeof x.errorMessage !== 'string')
        return false;
    return true;
}
function isValidPolicyCallAttributes(x) {
    if (!isPlainObject(x))
        return false;
    if (x.kind !== 'policy_call')
        return false;
    if (!isValidPolicyDecision(x.decision))
        return false;
    if (!isValidPolicySource(x.source))
        return false;
    if (!isStringOrNull(x.policyId))
        return false;
    if (!isStringOrNull(x.policyName))
        return false;
    if (!isStringOrNull(x.policyHash))
        return false;
    if (!isStringOrNull(x.policyVersion))
        return false;
    if (!isStringOrNull(x.matchedRuleId))
        return false;
    if (!isStringOrNull(x.reason))
        return false;
    if (!isStringOrNull(x.delegationId))
        return false;
    if (!isStringArrayOrEmpty(x.dataClasses))
        return false;
    if ('enforcementAction' in x &&
        x.enforcementAction !== null &&
        !isValidPolicyEnforcementAction(x.enforcementAction))
        return false;
    return true;
}
function isValidGenerationAttributes(x) {
    if (!isPlainObject(x))
        return false;
    if (x.kind !== 'generation')
        return false;
    if (typeof x.model !== 'string')
        return false;
    if (typeof x.inputTokens !== 'number' || !Number.isFinite(x.inputTokens))
        return false;
    if (typeof x.outputTokens !== 'number' || !Number.isFinite(x.outputTokens))
        return false;
    if (typeof x.costUsd !== 'number' || !Number.isFinite(x.costUsd))
        return false;
    if ('cacheReadTokens' in x &&
        x.cacheReadTokens !== null &&
        (typeof x.cacheReadTokens !== 'number' || !Number.isFinite(x.cacheReadTokens)))
        return false;
    if ('cacheWriteTokens' in x &&
        x.cacheWriteTokens !== null &&
        (typeof x.cacheWriteTokens !== 'number' || !Number.isFinite(x.cacheWriteTokens)))
        return false;
    if ('prompt' in x && x.prompt !== null && typeof x.prompt !== 'string')
        return false;
    if ('completion' in x &&
        x.completion !== null &&
        typeof x.completion !== 'string')
        return false;
    if ('finishReason' in x &&
        x.finishReason !== null &&
        typeof x.finishReason !== 'string')
        return false;
    return true;
}
function isValidEventAttributes(x) {
    if (!isPlainObject(x))
        return false;
    if (x.kind !== 'event')
        return false;
    if (typeof x.message !== 'string')
        return false;
    return isValidEventLevel(x.level);
}
function isValidSpanAttributes(x) {
    if (!isPlainObject(x))
        return false;
    const k = x.kind;
    if (k === 'span')
        return isValidGenericSpanAttributes(x);
    if (k === 'policy_call')
        return isValidPolicyCallAttributes(x);
    if (k === 'generation')
        return isValidGenerationAttributes(x);
    if (k === 'event')
        return isValidEventAttributes(x);
    return false;
}
function isValidTraceRecord(x) {
    if (!isPlainObject(x))
        return false;
    if (typeof x.id !== 'string' || x.id.length === 0)
        return false;
    if (typeof x.name !== 'string' || x.name.length === 0)
        return false;
    if (typeof x.startTime !== 'string')
        return false;
    if ('endTime' in x &&
        x.endTime !== null &&
        typeof x.endTime !== 'string')
        return false;
    if ('durationMs' in x &&
        x.durationMs !== null &&
        (typeof x.durationMs !== 'number' || !Number.isInteger(x.durationMs)))
        return false;
    if (!isValidSpanStatus(x.status))
        return false;
    if (!isStringOrNull(x.sessionId))
        return false;
    if (!isStringOrNull(x.userId))
        return false;
    if (!isStringOrNull(x.agentId))
        return false;
    if (!isPlainObject(x.attributes))
        return false;
    if (!isStringArrayOrEmpty(x.tags))
        return false;
    return true;
}
function isValidSpanRecord(x) {
    if (!isPlainObject(x))
        return false;
    if (typeof x.id !== 'string' || x.id.length === 0)
        return false;
    if (typeof x.name !== 'string' || x.name.length === 0)
        return false;
    if (typeof x.startTime !== 'string')
        return false;
    if ('endTime' in x &&
        x.endTime !== null &&
        typeof x.endTime !== 'string')
        return false;
    if ('durationMs' in x &&
        x.durationMs !== null &&
        (typeof x.durationMs !== 'number' || !Number.isInteger(x.durationMs)))
        return false;
    if (!isValidSpanKind(x.kind))
        return false;
    if (!isValidSpanStatus(x.status))
        return false;
    if (!isStringOrNull(x.parentSpanId))
        return false;
    if (!isStringOrNull(x.sessionId))
        return false;
    return isValidSpanAttributes(x.attributes);
}
function isValidIngestBatch(x) {
    if (!isPlainObject(x))
        return false;
    if (!isValidTraceRecord(x.trace))
        return false;
    if (!Array.isArray(x.spans))
        return false;
    for (const s of x.spans) {
        if (!isValidSpanRecord(s))
            return false;
    }
    return true;
}
function isValidIngestPayload(x) {
    if (!isPlainObject(x))
        return false;
    if (typeof x.product !== 'string' || x.product.length === 0)
        return false;
    if (!isStringOrNull(x.sessionId))
        return false;
    if (!Array.isArray(x.batches) || x.batches.length === 0)
        return false;
    for (const b of x.batches) {
        if (!isValidIngestBatch(b))
            return false;
    }
    return true;
}
function mintId() {
    return (0, crypto_1.randomUUID)();
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(x) {
    return typeof x === 'string' && UUID_RE.test(x);
}
