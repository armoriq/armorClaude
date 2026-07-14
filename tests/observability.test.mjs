import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../scripts/lib/config.mjs";

test("observabilityEnabled true when daemon on + api key present", () => {
  const cfg = loadConfig({
    ARMORIQ_ENV: "local",
    ARMORIQ_BACKEND_URL: "http://localhost:8080",
    ARMORIQ_API_KEY: "ak_live_test0000000000000000000000000000",
  });
  assert.equal(cfg.observabilityEnabled, true);
  assert.equal(cfg.observabilityEndpoint, "http://localhost:8080");
  assert.equal(cfg.observabilityProduct, "armorclaude");
});

import { isObsEnabled, __resetObsForTests } from "../scripts/lib/observability.mjs";

test("isObsEnabled reflects config flag", () => {
  assert.equal(isObsEnabled({ observabilityEnabled: true }), true);
  assert.equal(isObsEnabled({ observabilityEnabled: false }), false);
  assert.equal(isObsEnabled(undefined), false);
});

test("__resetObsForTests exists and is callable", () => {
  __resetObsForTests();
  assert.ok(true);
});

import armoriqSdk from "@armoriq/sdk";
import { observeHook } from "../scripts/lib/observability.mjs";

const SDK_HAS_SPANS = typeof armoriqSdk.openSpan === "function";

test("observeHook builds a nested iap.plan trace per turn", { skip: !SDK_HAS_SPANS && "SDK <0.6.3 (no openSpan export)" }, async () => {
  __resetObsForTests();
  const events = [];
  armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
  const config = {
    observabilityEnabled: true,
    observabilityEndpoint: "http://localhost:8080",
    observabilityProduct: "armorclaude",
    apiKey: "ak_live_test0000000000000000000000000000",
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
  };
  const sid = "11111111-1111-4111-8111-111111111111";

  await observeHook("UserPromptSubmit", { session_id: sid, prompt: "find acme" }, null, config);
  await observeHook("PreToolUse", { session_id: sid, tool_name: "search_contacts", tool_input: { query: "acme" } }, null, config);
  await observeHook("PostToolUse", { session_id: sid, tool_name: "search_contacts", tool_input: { query: "acme" }, tool_response: { matches: 1 } }, null, config);
  await observeHook("SessionEnd", { session_id: sid }, null, config);

  armoriqSdk.__setObservabilitySinkForTests(null);

  const spanNames = events.filter((e) => e.kind === "span_recorded").map((e) => e.span.name);
  assert.ok(spanNames.includes("iap.plan.start"), "has iap.plan.start");
  assert.ok(spanNames.includes("iap.check"), "has iap.check");
  assert.ok(spanNames.includes("tool.report"), "has tool.report");
  const ended = events.filter((e) => e.kind === "trace_ended");
  assert.ok(ended.length >= 1, "trace ended");
  assert.equal(ended[ended.length - 1].trace.name, "iap.plan");
});

test("observeHook records deny decision on iap.check", { skip: !SDK_HAS_SPANS && "SDK <0.6.3" }, async () => {
  __resetObsForTests();
  const events = [];
  armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
  const config = { observabilityEnabled: true, observabilityEndpoint: "http://localhost:8080", observabilityProduct: "armorclaude", apiKey: "ak_live_test0000000000000000000000000000", sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 } };
  const sid = "22222222-2222-4222-8222-222222222222";
  await observeHook("UserPromptSubmit", { session_id: sid, prompt: "x" }, null, config);
  const denyOut = { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "not in plan" } };
  await observeHook("PreToolUse", { session_id: sid, tool_name: "rm", tool_input: {} }, denyOut, config);
  await observeHook("SessionEnd", { session_id: sid }, null, config);
  armoriqSdk.__setObservabilitySinkForTests(null);
  const pc = events.find((e) => e.kind === "span_recorded" && e.span.attributes && e.span.attributes.kind === "policy_call");
  assert.ok(pc, "policy_call span present");
  assert.equal(pc.span.attributes.decision, "deny");
});

test("observeHook is a no-op when disabled and never throws", async () => {
  __resetObsForTests();
  await observeHook("UserPromptSubmit", { session_id: "x", prompt: "y" }, null, { observabilityEnabled: false });
  assert.ok(true);
});

test("observeHook tolerates missing session_id", async () => {
  __resetObsForTests();
  await observeHook("PreToolUse", { tool_name: "x" }, null, { observabilityEnabled: true, observabilityEndpoint: "http://x", observabilityProduct: "armorclaude", apiKey: "ak_live_test0000000000000000000000000000", sanitize: {} });
  assert.ok(true);
});

// Regression: trace.userId is a UUID-typed backend column (obs_traces.user_id,
// ingest schema `z.uuid()`) — armorClaude's logical "claude-user" is NOT a
// UUID and must be emitted as null, or the ingest POST 400s and every trace
// is silently dropped. trace.agentId, by contrast, is a free-form `text`
// column with no UUID requirement — armorClaude's logical "claude-code" IS a
// valid value and must flow through as-is (this used to be incorrectly
// null'd by the same UUID gate as userId/sessionId — the root cause of the
// dashboard's empty AGENT column).
test("non-UUID config userId is null but non-UUID agentId flows through on the trace", { skip: !SDK_HAS_SPANS && "SDK <0.6.3" }, async () => {
  __resetObsForTests();
  const events = [];
  armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
  const config = {
    observabilityEnabled: true,
    observabilityEndpoint: "http://localhost:8080",
    observabilityProduct: "armorclaude",
    apiKey: "ak_live_test0000000000000000000000000000",
    userId: "claude-user",
    agentId: "claude-code",
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
  };
  const sid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await observeHook("UserPromptSubmit", { session_id: sid, prompt: "hi" }, null, config);
  await observeHook("SessionEnd", { session_id: sid }, null, config);
  armoriqSdk.__setObservabilitySinkForTests(null);
  const started = events.find((e) => e.kind === "trace_started");
  assert.ok(started, "trace started");
  assert.equal(started.trace.userId, null, "non-UUID userId must be null");
  assert.equal(started.trace.agentId, "claude-code", "non-UUID agentId must flow through as-is");
});

// Regression: a raw string prompt must be captured (not turned into {}).
test("iap.plan.start captures the prompt text", { skip: !SDK_HAS_SPANS && "SDK <0.6.3" }, async () => {
  __resetObsForTests();
  const events = [];
  armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
  const config = {
    observabilityEnabled: true,
    observabilityEndpoint: "http://localhost:8080",
    observabilityProduct: "armorclaude",
    apiKey: "ak_live_test0000000000000000000000000000",
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
  };
  const sid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await observeHook("UserPromptSubmit", { session_id: sid, prompt: "Find Acme contacts" }, null, config);
  await observeHook("SessionEnd", { session_id: sid }, null, config);
  armoriqSdk.__setObservabilitySinkForTests(null);
  const planStart = events.find((e) => e.kind === "span_recorded" && e.span.name === "iap.plan.start");
  assert.ok(planStart, "iap.plan.start recorded");
  assert.equal(planStart.span.attributes.prompt, "Find Acme contacts");
});

// Regression: the dashboard's trace-list INPUT column reads
// `trace.attributes.input` — the turn's goal must land there too (not just
// on the child `iap.plan.start` span's `attributes.prompt`).
test("iap.plan trace carries attributes.input", { skip: !SDK_HAS_SPANS && "SDK <0.6.3" }, async () => {
  __resetObsForTests();
  const events = [];
  armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
  const config = {
    observabilityEnabled: true,
    observabilityEndpoint: "http://localhost:8080",
    observabilityProduct: "armorclaude",
    apiKey: "ak_live_test0000000000000000000000000000",
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
  };
  const sid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await observeHook("UserPromptSubmit", { session_id: sid, prompt: "Find Acme contacts" }, null, config);
  await observeHook("SessionEnd", { session_id: sid }, null, config);
  armoriqSdk.__setObservabilitySinkForTests(null);
  const started = events.find((e) => e.kind === "trace_started");
  assert.ok(started, "trace started");
  assert.equal(started.trace.attributes.input, "Find Acme contacts");
});

// Regression: dashboard TAGS/OUTPUT columns are derived by the SDK at
// endTrace() time from the trace's own policy_call spans — armorClaude
// doesn't need its own tally, but the derivation must actually fire for a
// real armorClaude-shaped trace (iap.check span with toolName + child
// policy_call span with a decision).
test("trace_ended carries derived tags and output summary from tool checks", { skip: !SDK_HAS_SPANS && "SDK <0.6.3" }, async () => {
  __resetObsForTests();
  const events = [];
  armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
  const config = {
    observabilityEnabled: true,
    observabilityEndpoint: "http://localhost:8080",
    observabilityProduct: "armorclaude",
    apiKey: "ak_live_test0000000000000000000000000000",
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
  };
  const sid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await observeHook("UserPromptSubmit", { session_id: sid, prompt: "List files" }, null, config);
  await observeHook(
    "PreToolUse",
    { session_id: sid, tool_name: "Bash", tool_input: { command: "ls" } },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config
  );
  await observeHook("SessionEnd", { session_id: sid }, null, config);
  armoriqSdk.__setObservabilitySinkForTests(null);
  const ended = events.find((e) => e.kind === "trace_ended");
  assert.ok(ended, "trace ended");
  assert.ok(ended.trace.tags.includes("armorclaude"), "tags include product");
  assert.ok(ended.trace.tags.includes("Bash"), "tags include checked tool name");
  assert.ok(ended.trace.tags.includes("allowed"), "tags include overall verdict");
  assert.equal(ended.trace.attributes.output, "1 check · all allowed");
});
