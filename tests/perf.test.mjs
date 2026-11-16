import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePreToolUse } from "../scripts/lib/engine.mjs";

function buildPerfConfig(tmpDir) {
  return {
    mode: "enforce",
    dataDir: tmpDir,
    policyFile: path.join(tmpDir, "policy.json"),
    runtimeFile: path.join(tmpDir, "runtime.json"),
    backendEndpoint: "http://127.0.0.1:3000",
    csrgEndpoint: "http://127.0.0.1:8000",
    apiKey: "",
    useSdkIntent: false,
    intentEndpoint: "",
    verifyStepEndpoint: "",
    validitySeconds: 600,
    refreshThresholdSeconds: 30,
    timeoutMs: 5000,
    maxRetries: 1,
    verifySsl: true,
    llmId: "claude-code",
    mcpName: "claude-code",
    userId: "test-user",
    agentId: "test-agent",
    contextId: "default",
    intentRequired: true,
    requireCsrgProofs: false,
    csrgVerifyEnabled: false,
    policyUpdateEnabled: true,
    policyUpdateAllowList: ["*"],
    contextHintsEnabled: true,
    cryptoPolicyEnabled: false,
    auditEnabled: false,
    planningEnabled: false,
    autoReanchor: false,
    autoRevokeOnEnd: false,
    strictParamCheck: false,
    debug: false,
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
  };
}

async function timed(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  return { elapsedMs, result };
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  return { min: sorted[0], p50: p(0.5), p95: p(0.95), max: sorted[sorted.length - 1] };
}

const CI = Boolean(process.env.CI);
const perfCeiling = (local, ci) => (CI ? ci : local);

const PERF_WARMUP_ITERATIONS = 5;

test("PERF: read-only fast-path tools p95 < 5ms (engine handler only)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-perf-fastpath-"));
  const config = buildPerfConfig(tmp);
  const samples = [];
  for (const tool of [
    "read",
    "grep",
    "glob",
    "websearch",
    "webfetch",
    "exitplanmode",
    "toolsearch",
    "todowrite",
  ]) {
    for (let i = 0; i < 20; i++) {
      const { elapsedMs } = await timed(() =>
        handlePreToolUse(
          {
            hook_event_name: "PreToolUse",
            session_id: "sess-perf",
            tool_name: tool,
            tool_input: {},
          },
          config
        )
      );
      if (i >= PERF_WARMUP_ITERATIONS) samples.push(elapsedMs);
    }
  }
  const stats = summarize(samples);
  const ceiling = perfCeiling(5, 25);
  assert.ok(
    stats.p95 < ceiling,
    `Read-only fast-path p95 should be < ${ceiling} ms; got p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`
  );
});

test("PERF: warm-path Bash with valid plan p95 < 100ms (engine handler only)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-perf-warm-"));
  const config = buildPerfConfig(tmp);
  await writeFile(
    config.runtimeFile,
    JSON.stringify({
      sessions: {
        "sess-warm": {
          plan: { goal: "warm-path test", steps: [{ action: "Bash" }] },
          allowedActions: ["bash"],
          lastPrompt: "warm-path test",
          updatedAt: Math.floor(Date.now() / 1000),
          startedAt: Math.floor(Date.now() / 1000),
        },
      },
    })
  );
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const { elapsedMs } = await timed(() =>
      handlePreToolUse(
        {
          hook_event_name: "PreToolUse",
          session_id: "sess-warm",
          tool_name: "bash",
          tool_input: { command: `echo iter-${i}` },
        },
        config
      )
    );
    if (i >= PERF_WARMUP_ITERATIONS) samples.push(elapsedMs);
  }
  const stats = summarize(samples);
  const ceiling = perfCeiling(100, 400);
  assert.ok(
    stats.p95 < ceiling,
    `Warm-path p95 should be < ${ceiling} ms; got p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`
  );
});
