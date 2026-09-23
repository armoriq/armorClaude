"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveTraceSummary = deriveTraceSummary;
const MAX_TOOL_TAGS = 8;
function isPolicyCallAttributes(attrs) {
    return attrs.kind === 'policy_call';
}
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
