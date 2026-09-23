"use strict";
/**
 * Trace-level tag/output-summary derivation.
 *
 * A trace's own `tags`/`attributes.output` are never populated by callers
 * today (every chokepoint only passes freeform `attributes` at
 * `startTrace()` time, before any child span exists) — so without this
 * module every trace ships with `tags: []` and no output summary, even
 * though the information needed to compute both already lives on the
 * trace's own spans by the time `endTrace()` runs.
 *
 * This is intentionally derived, not caller-supplied: it's computed once,
 * in one place (`ObservabilityRecorder.endTrace`), from the same in-memory
 * `spans` array the recorder already holds — no new public API surface,
 * no risk of callers drifting from each other's tagging conventions.
 *
 * Kept deliberately conservative and low-cardinality (per the dashboard's
 * TAGS column contract): product + distinct tool names + one decision
 * verdict, nothing free-text or unbounded.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveTraceSummary = deriveTraceSummary;
const MAX_TOOL_TAGS = 8;
function isPolicyCallAttributes(attrs) {
    return attrs.kind === 'policy_call';
}
/**
 * Distinct tool names referenced by any span on the trace. Reads
 * `attributes.toolName` off `kind: 'span'` container spans (the shape
 * `iap.check`/`tool.report`/generic tool spans use) — this covers every
 * known emitter without needing parent/child span-kind coupling.
 */
function collectToolNames(spans) {
    const names = new Set();
    for (const span of spans) {
        const toolName = span.attributes.toolName;
        if (typeof toolName === 'string' && toolName.length > 0) {
            names.add(toolName);
        }
    }
    return Array.from(names).slice(0, MAX_TOOL_TAGS);
}
function collectDecisionCounts(spans) {
    const counts = { allow: 0, deny: 0, other: 0, total: 0 };
    for (const span of spans) {
        if (!isPolicyCallAttributes(span.attributes))
            continue;
        counts.total += 1;
        if (span.attributes.decision === 'allow')
            counts.allow += 1;
        else if (span.attributes.decision === 'deny')
            counts.deny += 1;
        else
            counts.other += 1;
    }
    return counts;
}
/** Overall verdict tag for the trace: 'allowed' | 'blocked' | 'mixed'. */
function decisionVerdict(counts) {
    if (counts.total === 0)
        return null;
    if (counts.deny > 0 && counts.deny < counts.total)
        return 'mixed';
    if (counts.deny === counts.total)
        return 'blocked';
    if (counts.other > 0)
        return 'mixed';
    return 'allowed';
}
/** Concise, non-sensitive outcome summary, e.g. "5 checks · all allowed". */
function outputSummary(counts) {
    if (counts.total === 0)
        return null;
    const noun = counts.total === 1 ? 'check' : 'checks';
    if (counts.deny === 0 && counts.other === 0) {
        return `${counts.total} ${noun} · all allowed`;
    }
    if (counts.deny === counts.total) {
        return `${counts.total} ${noun} · all blocked`;
    }
    const parts = [];
    if (counts.deny > 0)
        parts.push(`${counts.deny} blocked`);
    if (counts.other > 0)
        parts.push(`${counts.other} pending`);
    return `${counts.total} ${noun} · ${parts.join(', ')}`;
}
/**
 * Derive `{ tags, output }` for a trace from its accumulated spans. Pure
 * and read-only — never mutates `spans`. Callers merge the result onto the
 * trace record themselves (see `ObservabilityRecorder.endTrace`), preserving
 * any tags/output the caller already set explicitly.
 */
function deriveTraceSummary(spans, product) {
    const tags = [];
    if (product)
        tags.push(product);
    tags.push(...collectToolNames(spans));
    const counts = collectDecisionCounts(spans);
    const verdict = decisionVerdict(counts);
    if (verdict)
        tags.push(verdict);
    return {
        tags,
        output: outputSummary(counts),
    };
}
