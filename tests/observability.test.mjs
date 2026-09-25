import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../scripts/lib/config.mjs";
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-node";

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

import {
  isObsEnabled,
  __resetObsForTests,
  __setOtelTestHooksForTests,
} from "../scripts/lib/observability.mjs";

test("isObsEnabled reflects config flag", () => {
  assert.equal(isObsEnabled({ observabilityEnabled: true }), true);
  assert.equal(isObsEnabled({ observabilityEnabled: false }), false);
  assert.equal(isObsEnabled(undefined), false);
});

test("__resetObsForTests exists and is callable", () => {
  __resetObsForTests();
  assert.ok(true);
});

import armoriqSdk from "@armoriq/sdk-dev";
import { observeHook, obsFlush, obsFlushAll } from "../scripts/lib/observability.mjs";

test("installed SDK provides every required observability export", () => {
  for (const name of ["ArmorIQTelemetryRuntime", "OtelSession"]) {
    assert.equal(typeof armoriqSdk[name], "function", `Missing required SDK export: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Otel test harness: caller-owned provider + authoritative stub lease, so no
// test touches the network. Mirrors what the bridge wires in production
// (backend lease endpoint + SDK-owned exporter) without any of its I/O.
// ---------------------------------------------------------------------------

const OTEL_ENV_KEYS = [
  "ARMORIQ_OBSERVABILITY",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
  "ARMORIQ_OTEL_EXPORTER",
  "ARMORIQ_OTEL_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "ARMORIQ_OTEL_CAPTURE_MODE",
];

const savedEnv = {};
for (const key of OTEL_ENV_KEYS) {
  savedEnv[key] = process.env[key];
  delete process.env[key];
}
test.after(() => {
  for (const key of OTEL_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  __setOtelTestHooksForTests(null);
});

let exporter;
let provider;

function installHooks() {
  __resetObsForTests();
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  __setOtelTestHooksForTests({
    tracerProvider: provider,
    leaseFetcher: async () => ({
      captureMode: "metadata",
      revision: 1,
      expiresAt: new Date(Date.now() + 3600_000),
      authoritative: true,
      contentCaptureAllowed: false,
      externalContentCaptureAllowed: false,
      externalContentAllowed: false,
      contentReasonCode: "test",
      debugExpiresAt: null,
    }),
  });
  return exporter;
}

function testConfig() {
  return {
    observabilityEnabled: true,
    observabilityEndpoint: "http://127.0.0.1:1",
    observabilityProduct: "armorclaude",
    apiKey: "ak_test_otelhooks000000000000000000",
    agentId: "claude-code",
    userId: "claude-user",
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
  };
}

function spans() {
  return exporter.getFinishedSpans();
}

function spansByName(name) {
  return spans().filter((s) => s.name === name);
}

test("observeHook builds one turn root per session", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("SessionStart", { session_id: "sess-turn" }, null, config);
  await observeHook(
    "UserPromptSubmit",
    { session_id: "sess-turn", prompt: "deploy staging now" },
    null,
    config
  );
  await observeHook("SessionEnd", { session_id: "sess-turn" }, null, config);
  const roots = spansByName("armoriq.agent.run").filter((s) => !s.parentSpanContext?.spanId);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].attributes["session.id"], "sess-turn");
  assert.equal(roots[0].attributes["gen_ai.agent.name"], "claude-code");
  await provider.shutdown();
});

test("PreToolUse deny records a blocked policy evaluation", async () => {
  installHooks();
  const config = testConfig();
  await observeHook(
    "PreToolUse",
    { session_id: "sess-deny", tool_name: "Bash", tool_input: { command: "rm -rf /" } },
    {
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "no registered plan",
      },
    },
    config
  );
  await observeHook("SessionEnd", { session_id: "sess-deny" }, null, config);
  const policy = spansByName("armoriq.policy.evaluate");
  assert.equal(policy.length, 1);
  assert.equal(policy[0].attributes["armoriq.policy.decision"], "deny");
  assert.equal(policy[0].attributes["armoriq.policy.reason_code"], "no registered plan");
  await provider.shutdown();
});

test("PreToolUse allow records an allowed policy evaluation", async () => {
  installHooks();
  const config = testConfig();
  await observeHook(
    "PreToolUse",
    { session_id: "sess-allow", tool_name: "Read", tool_input: { file_path: "x.txt" } },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config
  );
  await observeHook("SessionEnd", { session_id: "sess-allow" }, null, config);
  const policy = spansByName("armoriq.policy.evaluate");
  assert.equal(policy.length, 1);
  assert.equal(policy[0].attributes["armoriq.policy.decision"], "allow");
  await provider.shutdown();
});

test("PostToolUse records a succeeded tool span", async () => {
  installHooks();
  const config = testConfig();
  await observeHook(
    "PostToolUse",
    {
      session_id: "sess-tool",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { output: "x" },
    },
    null,
    config
  );
  await observeHook("SessionEnd", { session_id: "sess-tool" }, null, config);
  const tools = spansByName("armoriq.tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].attributes["armoriq.tool.name"], "Bash");
  assert.equal(tools[0].attributes["armoriq.tool.outcome"], "success");
  assert.equal(tools[0].attributes["armoriq.operation.category"], "tool");
  await provider.shutdown();
});

test("PostToolUseFailure records a failed tool span", async () => {
  installHooks();
  const config = testConfig();
  await observeHook(
    "PostToolUseFailure",
    {
      session_id: "sess-toolfail",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: null,
    },
    null,
    config
  );
  await observeHook("SessionEnd", { session_id: "sess-toolfail" }, null, config);
  const tools = spansByName("armoriq.tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].attributes["armoriq.tool.outcome"], "error");
  await provider.shutdown();
});

test("MCP tools are bucketed as mcp operations", async () => {
  installHooks();
  const config = testConfig();
  await observeHook(
    "PostToolUse",
    {
      session_id: "sess-mcp",
      tool_name: "mcp__github__get_issue",
      tool_input: {},
      tool_response: {},
    },
    null,
    config
  );
  await observeHook("SessionEnd", { session_id: "sess-mcp" }, null, config);
  const tools = spansByName("armoriq.tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].attributes["armoriq.operation.category"], "mcp");
  await provider.shutdown();
});

test("confirmed slash command expansions record a command operation", async () => {
  installHooks();
  const config = testConfig();
  await observeHook(
    "UserPromptExpansion",
    { session_id: "sess-slash", expansion_type: "slash_command", command_name: "/deploy" },
    null,
    config
  );
  await observeHook("SessionEnd", { session_id: "sess-slash" }, null, config);
  const ops = spansByName("command.execute");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].attributes["armoriq.operation.category"], "command");
  assert.equal(ops[0].attributes["armoriq.tool.name"], "deploy");
  await provider.shutdown();
});

test("slash command evidence ignores other expansions and malformed command names", async () => {
  installHooks();
  const config = testConfig();
  const cases = [
    { expansion_type: "other", command_name: "/deploy" },
    { expansion_type: "slash_command" },
    { expansion_type: "slash_command", command_name: 42 },
    { expansion_type: "slash_command", command_name: "/" },
    { expansion_type: "slash_command", command_name: "/has space" },
    { expansion_type: "slash_command", command_name: "//double" },
    { expansion_type: "slash_command", command_name: "x".repeat(81) },
    { session_id: "sess-noise", prompt: "/deploy staging now" },
  ];
  for (const input of cases) {
    await observeHook("UserPromptExpansion", { session_id: "sess-noise", ...input }, null, config);
  }
  await observeHook("SessionEnd", { session_id: "sess-noise" }, null, config);
  assert.equal(spansByName("command.execute").length, 0);
  await provider.shutdown();
});

test("disabled config records nothing", async () => {
  installHooks();
  const config = { ...testConfig(), observabilityEnabled: false };
  await observeHook("SessionStart", { session_id: "sess-off" }, null, config);
  await observeHook(
    "PreToolUse",
    { session_id: "sess-off", tool_name: "Bash", tool_input: {} },
    { hookSpecificOutput: { permissionDecision: "deny" } },
    config
  );
  assert.equal(spans().length, 0);
  await provider.shutdown();
});

test("missing session id records nothing and never throws", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("PreToolUse", { tool_name: "Bash" }, null, config);
  await observeHook("PreToolUse", null, null, config);
  assert.equal(spans().length, 0);
  await provider.shutdown();
});

test("Stop keeps the session usable and SessionEnd drops it", async () => {
  installHooks();
  const config = testConfig();
  await observeHook(
    "PreToolUse",
    { session_id: "sess-stop", tool_name: "Bash", tool_input: {} },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config
  );
  const afterCheck = spans().length;
  assert.ok(afterCheck > 0);
  await observeHook("Stop", { session_id: "sess-stop" }, null, config);
  await observeHook(
    "PreToolUse",
    { session_id: "sess-stop", tool_name: "Read", tool_input: {} },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config
  );
  assert.ok(spans().length > afterCheck, "session still emits after Stop");
  await observeHook("SessionEnd", { session_id: "sess-stop" }, null, config);
  const afterEnd = spans().length;
  await observeHook(
    "PreToolUse",
    { session_id: "sess-stop", tool_name: "Read", tool_input: {} },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config
  );
  assert.ok(spans().length > afterEnd, "a new session starts cleanly after SessionEnd");
  await provider.shutdown();
});

test("obsFlush and obsFlushAll are callable and fail-open", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("SessionStart", { session_id: "sess-flush" }, null, config);
  await obsFlush("sess-flush", config);
  await obsFlush("sess-unknown", config);
  await obsFlushAll();
  await obsFlush("sess-flush", { ...config, observabilityEnabled: false });
  assert.ok(true);
  await provider.shutdown();
});

test("observeHook never throws on garbage input", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("PreToolUse", null, null, config);
  await observeHook("BogusEvent", {}, {}, config);
  await observeHook("PostToolUse", { session_id: "sess-garbage" }, null, config);
  assert.ok(true);
  await provider.shutdown();
});

test("connect root carries session identity", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("SessionStart", { session_id: "sess-connect" }, null, config);
  await observeHook("SessionEnd", { session_id: "sess-connect" }, null, config);
  const roots = spansByName("armoriq.agent.run").filter((s) => !s.parentSpanContext?.spanId);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].attributes["session.id"], "sess-connect");
  assert.equal(roots[0].attributes["user.id"], "claude-user");
  await provider.shutdown();
});

test("events sent without awaiting are recorded in order once the lease arrives", async () => {
  installHooks();
  const config = testConfig();
  let answerLease;
  __setOtelTestHooksForTests({
    tracerProvider: provider,
    leaseFetcher: () =>
      new Promise((resolve) => {
        answerLease = () =>
          resolve({
            captureMode: "metadata",
            revision: 1,
            expiresAt: new Date(Date.now() + 3600_000),
            authoritative: true,
            contentCaptureAllowed: false,
            externalContentCaptureAllowed: false,
            externalContentAllowed: false,
            contentReasonCode: "test",
            debugExpiresAt: null,
          });
      }),
  });
  const tool = { session_id: "sess-queue", tool_name: "Bash", tool_input: {} };
  observeHook("SessionStart", { session_id: "sess-queue" }, null, config);
  observeHook("PreToolUse", tool, { hookSpecificOutput: { permissionDecision: "allow" } }, config);
  const last = observeHook("PostToolUse", { ...tool, tool_response: {} }, null, config);
  await new Promise((r) => setTimeout(r, 20));
  answerLease();
  await last;
  assert.equal(spansByName("armoriq.policy.evaluate").length, 1);
  assert.equal(spansByName("armoriq.tool").length, 1);
  await provider.shutdown();
});

test("obsFlushAll ends every open root with status process_exit", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("SessionStart", { session_id: "sess-shutdown" }, null, config);
  assert.equal(spansByName("armoriq.agent.run").length, 0, "the root is open");
  await obsFlushAll();
  const roots = spansByName("armoriq.agent.run");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].status.message, "process_exit");
  await provider.shutdown();
});
