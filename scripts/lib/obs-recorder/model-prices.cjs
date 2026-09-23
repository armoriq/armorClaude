"use strict";
/**
 * Static per-model token cost table.
 *
 * Best-effort, NOT billing-grade. Prices reflect Anthropic and OpenAI public
 * list prices as of 2026-07-15. Update this table via PR when list prices change;
 * we do not auto-sync because a billing-grade number must be auditable and
 * versioned.
 *
 * All prices are USD **per 1,000 tokens** (per-1k, not per-million). This
 * matches the precision the backend's `obs_spans.cost_usd` column keeps
 * (Decimal(12, 6)) and avoids float drift on small numbers.
 *
 * Cache pricing:
 *   - Anthropic: separate `cacheReadPer1kUsd` (cache hit) and
 *     `cacheWritePer1kUsd` (cache creation, 5-minute TTL).
 *   - OpenAI: no first-class cache tokens; we approximate cache reads as
 *     50% of the input price (matches OpenAI's "cached input" discount).
 *     Cache writes are charged as regular input.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODEL_PRICES = void 0;
exports.computeCostUsd = computeCostUsd;
exports.MODEL_PRICES = {
    // Anthropic Claude 4 family (claude-sonnet-4-20250514: $3 in / $15 out per MTok)
    'claude-sonnet-4-20250514': {
        inputPer1kUsd: 0.003,
        outputPer1kUsd: 0.015,
        cacheReadPer1kUsd: 0.0003,
        cacheWritePer1kUsd: 0.00375,
    },
    'claude-opus-4-20250514': {
        inputPer1kUsd: 0.015,
        outputPer1kUsd: 0.075,
        cacheReadPer1kUsd: 0.0015,
        cacheWritePer1kUsd: 0.01875,
    },
    'claude-haiku-4-20250514': {
        inputPer1kUsd: 0.001,
        outputPer1kUsd: 0.005,
        cacheReadPer1kUsd: 0.0001,
        cacheWritePer1kUsd: 0.00125,
    },
    // Anthropic Claude 5 family (same tier list prices as the 4 family:
    // Sonnet $3 in / $15 out, Opus $15 / $75, Haiku $1 / $5 per MTok).
    'claude-sonnet-5': {
        inputPer1kUsd: 0.003,
        outputPer1kUsd: 0.015,
        cacheReadPer1kUsd: 0.0003,
        cacheWritePer1kUsd: 0.00375,
    },
    'claude-opus-4-8': {
        inputPer1kUsd: 0.015,
        outputPer1kUsd: 0.075,
        cacheReadPer1kUsd: 0.0015,
        cacheWritePer1kUsd: 0.01875,
    },
    'claude-haiku-4-5-20251001': {
        inputPer1kUsd: 0.001,
        outputPer1kUsd: 0.005,
        cacheReadPer1kUsd: 0.0001,
        cacheWritePer1kUsd: 0.00125,
    },
    'claude-haiku-4-5': {
        inputPer1kUsd: 0.001,
        outputPer1kUsd: 0.005,
        cacheReadPer1kUsd: 0.0001,
        cacheWritePer1kUsd: 0.00125,
    },
    // OpenAI GPT-5.6 Standard, short context:
    // https://developers.openai.com/api/docs/pricing
    'gpt-5.6-sol': {
        inputPer1kUsd: 0.005,
        outputPer1kUsd: 0.03,
        cacheReadPer1kUsd: 0.0005,
        cacheWritePer1kUsd: 0.00625,
    },
    // OpenAI GPT-4o family
    'gpt-4o': {
        inputPer1kUsd: 0.0025,
        outputPer1kUsd: 0.01,
        cacheReadPer1kUsd: 0.00125,
        cacheWritePer1kUsd: 0.0025,
    },
    'gpt-4o-mini': {
        inputPer1kUsd: 0.00015,
        outputPer1kUsd: 0.0006,
        cacheReadPer1kUsd: 0.000075,
        cacheWritePer1kUsd: 0.00015,
    },
    // OpenAI GPT-4.1 family
    'gpt-4.1': {
        inputPer1kUsd: 0.002,
        outputPer1kUsd: 0.008,
        cacheReadPer1kUsd: 0.001,
        cacheWritePer1kUsd: 0.002,
    },
    'gpt-4.1-mini': {
        inputPer1kUsd: 0.0004,
        outputPer1kUsd: 0.0016,
        cacheReadPer1kUsd: 0.0002,
        cacheWritePer1kUsd: 0.0004,
    },
};
/**
 * Compute the USD cost of an LLM call given token counts.
 *
 * Unknown models return 0 (no pricing data) — the span still records the
 * tokens; the cost field is just `0` instead of estimated. This keeps the
 * aggregator safe when a new model is added before the price table is
 * updated.
 *
 * Returns a non-negative number, rounded to 6 decimal places to match the
 * backend's `obs_spans.cost_usd` column precision.
 */
function computeCostUsd(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
    const price = exports.MODEL_PRICES[model];
    if (!price)
        return 0;
    const safe = (n) => (Number.isFinite(n) && n > 0 ? n : 0);
    const cost = (safe(inputTokens) / 1000) * price.inputPer1kUsd +
        (safe(outputTokens) / 1000) * price.outputPer1kUsd +
        (safe(cacheReadTokens) / 1000) * price.cacheReadPer1kUsd +
        (safe(cacheWriteTokens) / 1000) * price.cacheWritePer1kUsd;
    return Math.round(cost * 1_000_000) / 1_000_000;
}
