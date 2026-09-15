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

test("installed SDK provides every required observability export", () => {
  for (const name of [
    "ObservabilityRecorder",
    "startTrace",
    "openSpan",
    "flushObservability",
    "isValidUuid",
  ]) {
    assert.equal(typeof armoriqSdk[name], "function", `Missing required SDK export: ${name}`);
  }
});

test(
  "observeHook builds a nested iap.plan trace per turn",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3 (no openSpan export)" },
  async () => {
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
    await observeHook(
      "PreToolUse",
      { session_id: sid, tool_name: "search_contacts", tool_input: { query: "acme" } },
      null,
      config
    );
    await observeHook(
      "PostToolUse",
      {
        session_id: sid,
        tool_name: "search_contacts",
        tool_input: { query: "acme" },
        tool_response: { matches: 1 },
      },
      null,
      config
    );
    await observeHook("SessionEnd", { session_id: sid }, null, config);

    armoriqSdk.__setObservabilitySinkForTests(null);

    const spanNames = events.filter((e) => e.kind === "span_recorded").map((e) => e.span.name);
    assert.ok(spanNames.includes("iap.plan.start"), "has iap.plan.start");
    assert.ok(spanNames.includes("iap.check"), "has iap.check");
    assert.ok(spanNames.includes("tool.report"), "has tool.report");
    const ended = events.filter((e) => e.kind === "trace_ended");
    assert.ok(ended.length >= 1, "trace ended");
    assert.equal(ended[ended.length - 1].trace.name, "iap.plan");
  }
);

test(
  "observeHook records deny decision on iap.check",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3" },
  async () => {
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
    const sid = "22222222-2222-4222-8222-222222222222";
    await observeHook("UserPromptSubmit", { session_id: sid, prompt: "x" }, null, config);
    const denyOut = {
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "not in plan" },
    };
    await observeHook(
      "PreToolUse",
      { session_id: sid, tool_name: "rm", tool_input: {} },
      denyOut,
      config
    );
    await observeHook("SessionEnd", { session_id: sid }, null, config);
    armoriqSdk.__setObservabilitySinkForTests(null);
    const pc = events.find(
      (e) =>
        e.kind === "span_recorded" && e.span.attributes && e.span.attributes.kind === "policy_call"
    );
    assert.ok(pc, "policy_call span present");
    assert.equal(pc.span.attributes.decision, "deny");
  }
);

test("observeHook is a no-op when disabled and never throws", async () => {
  __resetObsForTests();
  await observeHook("UserPromptSubmit", { session_id: "x", prompt: "y" }, null, {
    observabilityEnabled: false,
  });
  assert.ok(true);
});

test("observeHook tolerates missing session_id", async () => {
  __resetObsForTests();
  await observeHook("PreToolUse", { tool_name: "x" }, null, {
    observabilityEnabled: true,
    observabilityEndpoint: "http://x",
    observabilityProduct: "armorclaude",
    apiKey: "ak_live_test0000000000000000000000000000",
    sanitize: {},
  });
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
test(
  "non-UUID config userId is null but non-UUID agentId flows through on the trace",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3" },
  async () => {
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
  }
);

// Regression: a raw string prompt must be captured (not turned into {}).
test(
  "iap.plan.start captures the prompt text",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3" },
  async () => {
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
    await observeHook(
      "UserPromptSubmit",
      { session_id: sid, prompt: "Find Acme contacts" },
      null,
      config
    );
    await observeHook("SessionEnd", { session_id: sid }, null, config);
    armoriqSdk.__setObservabilitySinkForTests(null);
    const planStart = events.find(
      (e) => e.kind === "span_recorded" && e.span.name === "iap.plan.start"
    );
    assert.ok(planStart, "iap.plan.start recorded");
    assert.equal(planStart.span.attributes.prompt, "Find Acme contacts");
  }
);

// Regression: the dashboard's trace-list INPUT column reads
// `trace.attributes.input` — the turn's goal must land there too (not just
// on the child `iap.plan.start` span's `attributes.prompt`).
test(
  "iap.plan trace carries attributes.input",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3" },
  async () => {
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
    await observeHook(
      "UserPromptSubmit",
      { session_id: sid, prompt: "Find Acme contacts" },
      null,
      config
    );
    await observeHook("SessionEnd", { session_id: sid }, null, config);
    armoriqSdk.__setObservabilitySinkForTests(null);
    const started = events.find((e) => e.kind === "trace_started");
    assert.ok(started, "trace started");
    assert.equal(started.trace.attributes.input, "Find Acme contacts");
  }
);

const OBS_CONFIG = {
  observabilityEnabled: true,
  observabilityEndpoint: "http://localhost:8080",
  observabilityProduct: "armorclaude",
  apiKey: "ak_live_test0000000000000000000000000000",
  sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
};

test(
  "UserPromptSubmit starting with a slash is not command execution evidence",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3" },
  async () => {
    __resetObsForTests();
    const events = [];
    armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
    const sid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await observeHook(
      "UserPromptSubmit",
      { session_id: sid, prompt: "/deploy staging now" },
      null,
      OBS_CONFIG
    );
    await observeHook("SessionEnd", { session_id: sid }, null, OBS_CONFIG);
    armoriqSdk.__setObservabilitySinkForTests(null);
    const slash = events.find((e) => e.kind === "span_recorded" && e.span.name === "slash.command");
    assert.equal(slash, undefined, "raw prompt text does not confirm command expansion");
  }
);

test("confirmed slash command expansions normalize command names without arguments", async () => {
  for (const [commandName, expected] of [
    ["deploy", "/deploy"],
    [" /armorclaude:armor ", "/armorclaude:armor"],
    ["a".repeat(79), "/" + "a".repeat(79)],
  ]) {
    __resetObsForTests();
    const events = [];
    armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
    const sid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    try {
      await observeHook(
        "UserPromptSubmit",
        { session_id: sid, prompt: "/unconfirmed" },
        null,
        OBS_CONFIG
      );
      await observeHook(
        "UserPromptExpansion",
        {
          session_id: sid,
          expansion_type: "slash_command",
          command_name: commandName,
          command_args: "private argument text",
        },
        null,
        OBS_CONFIG
      );
    } finally {
      await observeHook("SessionEnd", { session_id: sid }, null, OBS_CONFIG);
      armoriqSdk.__setObservabilitySinkForTests(null);
    }
    const spans = events.filter(
      (e) => e.kind === "span_recorded" && e.span.name === "slash.command"
    );
    assert.equal(spans.length, 1, "only the confirmed expansion emits command activity");
    assert.deepEqual(spans[0].span.attributes, {
      kind: "span",
      operationCategory: "command",
      slashCommand: expected,
    });
  }
});

test("slash command evidence ignores other expansions and malformed command names", async () => {
  __resetObsForTests();
  const events = [];
  armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
  const sid = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  try {
    for (const input of [
      { expansion_type: "skill", command_name: "deploy" },
      { command_name: "deploy" },
      ...[
        undefined,
        null,
        42,
        "",
        " ",
        "/",
        "//deploy",
        "deploy staging",
        "deploy\nsecret",
        "a".repeat(80),
      ].map((command_name) => ({ expansion_type: "slash_command", command_name })),
    ]) {
      await observeHook("UserPromptExpansion", { session_id: sid, ...input }, null, OBS_CONFIG);
    }
  } finally {
    await observeHook("SessionEnd", { session_id: sid }, null, OBS_CONFIG);
    armoriqSdk.__setObservabilitySinkForTests(null);
  }
  assert.equal(
    events.filter((e) => e.kind === "span_recorded" && e.span.name === "slash.command").length,
    0
  );
});

test(
  "a plain (non-slash) prompt records no slash.command span",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3" },
  async () => {
    __resetObsForTests();
    const events = [];
    armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
    const sid = " effff-ffff"; // not used as UUID here; prompt is what matters
    await observeHook(
      "UserPromptSubmit",
      { session_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", prompt: "just find acme" },
      null,
      OBS_CONFIG
    );
    await observeHook(
      "SessionEnd",
      { session_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
      null,
      OBS_CONFIG
    );
    armoriqSdk.__setObservabilitySinkForTests(null);
    void sid;
    const slash = events.find((e) => e.kind === "span_recorded" && e.span.name === "slash.command");
    assert.equal(slash, undefined, "no slash.command span for a plain prompt");
  }
);

test(
  "SessionStart records an armorclaude.connected event on its own trace",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3" },
  async () => {
    __resetObsForTests();
    const events = [];
    armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
    const sid = "12121212-1212-4121-8121-121212121212";
    await observeHook("SessionStart", { session_id: sid }, null, OBS_CONFIG);
    armoriqSdk.__setObservabilitySinkForTests(null);
    const connect = events.find(
      (e) => e.kind === "span_recorded" && e.span.name === "armorclaude.connected"
    );
    assert.ok(connect, "armorclaude.connected span recorded");
    assert.equal(connect.span.attributes.operationCategory, "connect");
    const started = events.find(
      (e) => e.kind === "trace_started" && e.trace.name === "armorclaude.session"
    );
    assert.ok(started, "armorclaude.session trace started");
    const ended = events.find(
      (e) => e.kind === "trace_ended" && e.trace.name === "armorclaude.session"
    );
    assert.ok(ended, "armorclaude.session trace ended (ships independently)");
  }
);

test(
  "tool.report tags operationCategory tool vs mcp",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3" },
  async () => {
    __resetObsForTests();
    const events = [];
    armoriqSdk.__setObservabilitySinkForTests((e) => events.push(e));
    const sid = "13131313-1313-4131-8131-131313131313";
    await observeHook("UserPromptSubmit", { session_id: sid, prompt: "go" }, null, OBS_CONFIG);
    await observeHook(
      "PostToolUse",
      { session_id: sid, tool_name: "Read", tool_input: {}, tool_response: {} },
      null,
      OBS_CONFIG
    );
    await observeHook(
      "PostToolUse",
      {
        session_id: sid,
        tool_name: "mcp__github__create_issue",
        tool_input: {},
        tool_response: {},
      },
      null,
      OBS_CONFIG
    );
    await observeHook("SessionEnd", { session_id: sid }, null, OBS_CONFIG);
    armoriqSdk.__setObservabilitySinkForTests(null);
    const reports = events.filter(
      (e) => e.kind === "span_recorded" && e.span.name === "tool.report"
    );
    const cats = reports.map((r) => r.span.attributes.operationCategory);
    assert.ok(cats.includes("tool"), "plain tool tagged 'tool'");
    assert.ok(cats.includes("mcp"), "mcp__ tool tagged 'mcp'");
  }
);

// Regression: dashboard TAGS/OUTPUT columns are derived by the SDK at
// endTrace() time from the trace's own policy_call spans — armorClaude
// doesn't need its own tally, but the derivation must actually fire for a
// real armorClaude-shaped trace (iap.check span with toolName + child
// policy_call span with a decision).
test(
  "trace_ended carries derived tags and output summary from tool checks",
  { skip: !SDK_HAS_SPANS && "SDK <0.6.3" },
  async () => {
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
  }
);
