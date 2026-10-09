import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfigWithLogins } from "./helpers/login-profile.mjs";
import { denyPreToolWithHint } from "../scripts/lib/hook-output.mjs";
import { JOURNAL_MAX_ENTRIES } from "../scripts/lib/obs-journal.mjs";
import {
  NodeTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-node";

test("observabilityEnabled true when daemon on + api key present", () => {
  const cfg = loadConfigWithLogins(
    [{ backend: "http://localhost:8080", apiKey: "ak_live_test0000000000000000000000000000" }],
    { ARMORIQ_ENV: "local", ARMORIQ_BACKEND_URL: "http://localhost:8080" }
  );
  assert.equal(cfg.observabilityEnabled, true);
  assert.equal(cfg.observabilityEndpoint, "http://localhost:8080");
  assert.equal(cfg.observabilityProduct, "armorclaude");
});

import {
  isObsEnabled,
  __openSessionsForTests,
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
import {
  observeHook,
  obsServeAsDaemon,
  obsFlush,
  obsFlushAll,
  obsReleaseIdle,
  obsRetryBacklog,
} from "../scripts/lib/observability.mjs";
import { deadPid, placeFile } from "./helpers/obs-files.mjs";

test("installed SDK provides every required observability export", () => {
  for (const name of ["ArmorIQTelemetryRuntime", "OtelSession"]) {
    assert.equal(typeof armoriqSdk[name], "function", `Missing required SDK export: ${name}`);
  }
});

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

const stubLease = async () => ({
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

function installHooks() {
  __resetObsForTests();
  exporter = new InMemorySpanExporter();
  provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  __setOtelTestHooksForTests({
    tracerProvider: provider,
    leaseFetcher: stubLease,
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

test("PreToolUse deny records a blocked policy evaluation under the rule's code, not its text (#201)", async () => {
  installHooks();
  const config = testConfig();
  await observeHook(
    "PreToolUse",
    { session_id: "sess-deny", tool_name: "Bash", tool_input: { command: "rm -rf /" } },
    denyPreToolWithHint("intent_plan_missing", "no registered plan", {
      toolName: "Bash",
      toolInput: { command: "rm -rf /" },
    }),
    config
  );
  await observeHook("SessionEnd", { session_id: "sess-deny" }, null, config);
  const policy = spansByName("armoriq.policy.evaluate");
  assert.equal(policy.length, 1);
  assert.equal(policy[0].attributes["armoriq.policy.decision"], "deny");
  assert.equal(policy[0].attributes["armoriq.policy.reason_code"], "intent_plan_missing");
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

test("a tool call's policy and tool spans carry its tool_use_id as armoriq.tool.call_id (#192)", async () => {
  installHooks();
  const config = testConfig();
  const allow = { hookSpecificOutput: { permissionDecision: "allow" } };
  const calls = [
    { tool_name: "Bash", tool_use_id: "toolu_01AbCdEf", failed: false },
    { tool_name: "mcp__docs__fetch_doc", tool_use_id: "toolu_01GhIjKl", failed: true },
  ];
  for (const { failed, ...call } of calls) {
    const tool = { session_id: "sess-call-id", tool_input: {}, ...call };
    await observeHook("PreToolUse", tool, allow, config);
    const post = failed ? "PostToolUseFailure" : "PostToolUse";
    await observeHook(post, { ...tool, tool_response: {} }, null, config);
  }
  await observeHook("SessionEnd", { session_id: "sess-call-id" }, null, config);
  const ids = (name) => spansByName(name).map((s) => s.attributes["armoriq.tool.call_id"]);
  const expected = calls.map((c) => c.tool_use_id);
  assert.deepEqual(ids("armoriq.policy.evaluate"), expected);
  assert.deepEqual(ids("armoriq.tool"), expected);
  await provider.shutdown();
});

test("a tool event without a string tool_use_id records no caller call id (#192)", async () => {
  installHooks();
  const config = testConfig();
  const tool = { session_id: "sess-no-call-id", tool_name: "Read", tool_input: {}, tool_use_id: 7 };
  await observeHook("PreToolUse", tool, null, config);
  await observeHook("PostToolUse", { ...tool, tool_response: {} }, null, config);
  await observeHook("SessionEnd", { session_id: "sess-no-call-id" }, null, config);
  const [policy] = spansByName("armoriq.policy.evaluate");
  const [toolSpan] = spansByName("armoriq.tool");
  assert.equal(policy.attributes["armoriq.tool.call_id"], undefined);
  assert.match(toolSpan.attributes["armoriq.tool.call_id"], /^op-[0-9a-f]{32}$/);
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
        answerLease = () => resolve(stubLease());
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

test("obsFlushAll ends every open root ok, with no task outcome claimed", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("SessionStart", { session_id: "sess-shutdown" }, null, config);
  assert.equal(spansByName("armoriq.agent.run").length, 0, "the root is open");
  await obsFlushAll();
  const roots = spansByName("armoriq.agent.run");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].status.code, 1, "SpanStatusCode.OK");
  assert.equal(roots[0].attributes["gen_ai.task.outcome"], "unknown");
  await provider.shutdown();
});

test("obsFlush ends the fallback process's root ok, with no task outcome claimed (#167)", async () => {
  installHooks();
  const config = testConfig();
  await observeHook(
    "PreToolUse",
    { session_id: "sess-fallback", tool_name: "Read", tool_input: {} },
    { hookSpecificOutput: { permissionDecision: "allow" } },
    config
  );
  await obsFlush("sess-fallback", config);
  const roots = spansByName("armoriq.agent.run");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].status.code, 1, "SpanStatusCode.OK");
  assert.equal(roots[0].attributes["gen_ai.task.outcome"], "unknown");
  await provider.shutdown();
});

test("SessionEnd in a process with no open root records the session as completed (#167)", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("SessionEnd", { session_id: "sess-end-only" }, null, config);
  await obsFlush("sess-end-only", config);
  const roots = spansByName("armoriq.agent.run");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].status.code, 1, "SpanStatusCode.OK");
  assert.equal(roots[0].attributes["gen_ai.task.outcome"], "completed");
  assert.equal(roots[0].attributes["session.id"], "sess-end-only");
  await provider.shutdown();
});

test("a fallback hook process exits as soon as an instant lease resolves", () => {
  const bridge = new URL("../scripts/lib/observability.mjs", import.meta.url).href;
  const child = `
    import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
    import * as obs from ${JSON.stringify(bridge)};
    obs.__setOtelTestHooksForTests({ tracerProvider: new NodeTracerProvider(), leaseFetcher: ${stubLease} });
    const config = ${JSON.stringify(testConfig())};
    const started = performance.now();
    process.on("exit", () => process.stdout.write(String(performance.now() - started)));
    await obs.observeHook("PreToolUse", { session_id: "sess-exit", tool_name: "Bash" }, null, config);
    await obs.obsFlush("sess-exit", config);`;
  const args = ["--import", "./tests/setup/no-network.mjs", "--input-type=module", "-e", child];
  const env = { PATH: process.env.PATH, HOME: tmpdir() };
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number(result.stdout) < 250, `hook process stayed alive ${result.stdout} ms`);
});

test("a second obsFlushAll waits for the first, and later events are not recorded", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("SessionStart", { session_id: "sess-stop-a" }, null, config);
  let firstDone = false;
  obsFlushAll().then(() => (firstDone = true));
  await obsFlushAll();
  assert.ok(firstDone, "the second call resolved before the first finished");
  const tool = { session_id: "sess-stop-b", tool_name: "Bash", tool_input: {} };
  await observeHook("PreToolUse", tool, null, config);
  assert.equal(spansByName("armoriq.policy.evaluate").length, 0);
  await provider.shutdown();
});

test("obsReleaseIdle ends an idle session's root at its last event and keeps active ones", async () => {
  installHooks();
  const config = testConfig();
  await observeHook("SessionStart", { session_id: "sess-idle" }, null, config);
  const lastEventDone = Date.now();
  await obsReleaseIdle(60_000);
  assert.equal(spansByName("armoriq.agent.run").length, 0, "an active session stays open");
  await new Promise((r) => setTimeout(r, 300));
  await obsReleaseIdle(0);
  const roots = spansByName("armoriq.agent.run");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].attributes["gen_ai.task.outcome"], "unknown");
  const [seconds, nanos] = roots[0].endTime;
  assert.ok(seconds * 1000 + nanos / 1e6 <= lastEventDone, "the root ends at the last event");
  await provider.shutdown();
});

function slowLease(ms, counter = { fetches: 0 }) {
  return () => {
    counter.fetches += 1;
    return new Promise((resolve) => setTimeout(() => resolve(stubLease()), ms));
  };
}

test("a session's first events are recorded when the lease takes longer than 500 ms (#191)", async () => {
  installHooks();
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: slowLease(700) });
  const config = testConfig();
  const tool = { session_id: "sess-slow-lease", tool_name: "Bash", tool_input: {} };
  observeHook("SessionStart", { session_id: "sess-slow-lease" }, null, config);
  observeHook("PreToolUse", tool, { hookSpecificOutput: { permissionDecision: "allow" } }, config);
  observeHook("PostToolUse", { ...tool, tool_response: {} }, null, config);
  await observeHook("SessionEnd", { session_id: "sess-slow-lease" }, null, config);
  assert.equal(spansByName("armoriq.policy.evaluate").length, 1);
  assert.equal(spansByName("armoriq.tool").length, 1);
  assert.deepEqual(
    spansByName("armoriq.agent.run").map((r) => r.attributes["gen_ai.task.outcome"]),
    ["completed"]
  );
  await provider.shutdown();
});

function leaseFiles(dataDir) {
  return readdirSync(dataDir).filter((name) => /^obs-lease-[0-9a-f]{32}\.json$/.test(name));
}

async function storedLeases(dataDir, count) {
  const until = Date.now() + 2_000;
  while (leaseFiles(dataDir).length < count && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return leaseFiles(dataDir);
}

test("a later process reuses the stored lease, and another API key fetches its own (#191)", async () => {
  installHooks();
  const counter = { fetches: 0 };
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: slowLease(0, counter) });
  const dataDir = mkdtempSync(path.join(tmpdir(), "aq-lease-"));
  const config = { ...testConfig(), dataDir };
  await observeHook("SessionStart", { session_id: "sess-lease-a" }, null, config);
  const [file] = await storedLeases(dataDir, 1);
  assert.ok(file, "the lease was stored");
  assert.equal(statSync(path.join(dataDir, file)).mode & 0o777, 0o600);
  await obsFlushAll();
  __resetObsForTests();
  await observeHook("SessionStart", { session_id: "sess-lease-b" }, null, config);
  assert.equal(counter.fetches, 1, "the second runtime read the stored lease");
  await obsFlushAll();
  assert.equal(spansByName("armoriq.agent.run").length, 2);
  __resetObsForTests();
  const other = { ...config, apiKey: "ak_test_otelhooks111111111111111111" };
  await observeHook("SessionStart", { session_id: "sess-lease-c" }, null, other);
  assert.equal(counter.fetches, 2);
  assert.equal((await storedLeases(dataDir, 2)).length, 2);
  await obsFlushAll();
  await provider.shutdown();
});

test("an unreadable or unwritable lease store costs only a lease request (#191)", async () => {
  installHooks();
  const counter = { fetches: 0 };
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: slowLease(0, counter) });
  const parent = mkdtempSync(path.join(tmpdir(), "aq-lease-bad-"));
  const dataDir = path.join(parent, "file");
  writeFileSync(dataDir, "not a directory");
  await observeHook("SessionStart", { session_id: "sess-lease-bad" }, null, {
    ...testConfig(),
    dataDir,
  });
  await obsFlushAll();
  assert.equal(counter.fetches, 1);
  assert.equal(spansByName("armoriq.agent.run").length, 1);
  await provider.shutdown();
});

function hungLease() {
  return (signal) =>
    new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("aborted")))
    );
}

async function timedHookProcess(sessionId, config) {
  __resetObsForTests();
  const started = Date.now();
  await observeHook("SessionStart", { session_id: sessionId }, null, config);
  await obsFlush(sessionId, config);
  return Date.now() - started;
}

const rootSessions = () =>
  spansByName("armoriq.agent.run")
    .map((span) => span.attributes["session.id"])
    .sort();

const missFiles = (dataDir) => readdirSync(dataDir).filter((name) => name.endsWith(".miss"));

test("a hook process waits at most 1.5 s for a hung lease, and the next ones skip the wait for 30 s (#191)", async () => {
  installHooks();
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: hungLease() });
  const dataDir = mkdtempSync(path.join(tmpdir(), "aq-lease-hung-"));
  const config = { ...testConfig(), dataDir };
  const first = await timedHookProcess("sess-hung-1", config);
  assert.ok(first >= 1_400 && first < 3_000, `the first hook waited ${first} ms`);
  const second = await timedHookProcess("sess-hung-2", config);
  assert.ok(second < 500, `the second hook waited ${second} ms`);
  const [miss] = missFiles(dataDir);
  writeFileSync(path.join(dataDir, miss), String(Date.now() - 31_000));
  const third = await timedHookProcess("sess-hung-3", config);
  assert.ok(third >= 1_400, `a hook after the 30 s window waited ${third} ms`);
  await provider.shutdown();
});

test("a current stored lease wins over a lease miss recorded after it (#191)", async () => {
  installHooks();
  const counter = { fetches: 0 };
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: slowLease(0, counter) });
  const dataDir = mkdtempSync(path.join(tmpdir(), "aq-lease-won-"));
  const config = { ...testConfig(), dataDir };
  await timedHookProcess("sess-won-1", config);
  const [file] = await storedLeases(dataDir, 1);
  writeFileSync(path.join(dataDir, file.replace(/\.json$/, ".miss")), String(Date.now()));
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: hungLease() });
  const took = await timedHookProcess("sess-won-2", config);
  assert.ok(took < 500, `the hook adopted the stored lease in ${took} ms`);
  assert.equal(counter.fetches, 1);
  assert.equal(spansByName("armoriq.agent.run").length, 2);
  await provider.shutdown();
});

test("the daemon still waits out a slow lease, and the lease it stores ends the hooks' miss window (#191)", async () => {
  installHooks();
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: hungLease() });
  const dataDir = mkdtempSync(path.join(tmpdir(), "aq-lease-miss-"));
  const config = { ...testConfig(), dataDir };
  await timedHookProcess("sess-miss", config);
  __resetObsForTests();
  obsServeAsDaemon({});
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: slowLease(2_000) });
  await observeHook("SessionStart", { session_id: "sess-daemon" }, null, config);
  await obsFlushAll();
  assert.deepEqual(rootSessions(), ["sess-daemon", "sess-miss"], "the daemon waited 2 s");
  const until = Date.now() + 2_000;
  while (missFiles(dataDir).length > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(missFiles(dataDir), []);
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: hungLease() });
  const took = await timedHookProcess("sess-after", config);
  assert.ok(took < 500, `the hook read the stored lease in ${took} ms`);
  assert.deepEqual(rootSessions(), ["sess-after", "sess-daemon", "sess-miss"]);
  await provider.shutdown();
});

function switchableLease() {
  const lease = { up: false, fetches: 0 };
  lease.fetch = async () => {
    lease.fetches += 1;
    if (!lease.up) throw new Error("lease endpoint down");
    return stubLease();
  };
  return lease;
}

const journalFiles = (dataDir) => readdirSync(path.join(dataDir, "obs-journal"));

test("a daemon keeps the events it cannot record without a lease and records them once a lease arrives (#200)", async () => {
  installHooks();
  const lease = switchableLease();
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: lease.fetch });
  const config = { ...testConfig(), dataDir: mkdtempSync(path.join(tmpdir(), "aq-park-")) };
  await obsServeAsDaemon(config);
  const tool = { session_id: "sess-park", tool_name: "Bash", tool_input: {}, tool_use_id: "t1" };
  await observeHook("SessionStart", { session_id: "sess-park" }, null, config);
  await observeHook("PreToolUse", tool, null, config);
  assert.equal(spans().length, 0);
  assert.equal(journalFiles(config.dataDir).length, 2);
  lease.up = true;
  await obsRetryBacklog();
  await observeHook("Stop", { session_id: "sess-park" }, null, config);
  assert.equal(spansByName("armoriq.policy.evaluate").length, 1);
  assert.deepEqual(journalFiles(config.dataDir), []);
  await obsFlushAll();
  await provider.shutdown();
});

test("a daemon asks for one lease per key per pass, however many sessions wait on it (#200)", async () => {
  installHooks();
  const lease = switchableLease();
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: lease.fetch });
  const config = { ...testConfig(), dataDir: mkdtempSync(path.join(tmpdir(), "aq-parkmany-")) };
  await obsServeAsDaemon(config);
  const park = async (session_id) => {
    await observeHook("SessionStart", { session_id }, null, config);
    const tool = { session_id, tool_name: "Bash", tool_input: {}, tool_use_id: `t-${session_id}` };
    await observeHook("PreToolUse", tool, null, config);
  };
  const ids = Array.from({ length: 50 }, (_, i) => `sess-many-${i}`);
  await park(ids[0]);
  const first = lease.fetches;
  await Promise.all(ids.slice(1).map(park));
  assert.equal(lease.fetches, first, "49 more sessions asked for no lease of their own");
  await obsRetryBacklog();
  assert.equal(lease.fetches, first + 1, "a pass without a lease asks once and replays nothing");
  assert.equal(journalFiles(config.dataDir).length, 100);
  assert.equal(spans().length, 0);

  lease.up = true;
  await obsRetryBacklog();
  await obsFlushAll();
  assert.equal(lease.fetches, first + 2, "the sessions adopted the key's stored lease");
  assert.equal(spansByName("armoriq.policy.evaluate").length, 50);
  assert.deepEqual(journalFiles(config.dataDir), []);
  await provider.shutdown();
});

test("a pass without a lease still caps the journal, and daemon.log says events are parked (#200)", async () => {
  installHooks();
  const lease = switchableLease();
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: lease.fetch });
  const config = { ...testConfig(), dataDir: mkdtempSync(path.join(tmpdir(), "aq-parkcap-")) };
  await obsServeAsDaemon(config);
  await observeHook("SessionStart", { session_id: "sess-cap" }, null, config);
  const [own] = journalFiles(config.dataDir);
  const binding = own.split("-")[2];
  const now = Date.now();
  const dead = deadPid();
  for (let i = 0; i < JOURNAL_MAX_ENTRIES; i++) {
    const name = `${now - 60_000 + i}-0-${binding}-${randomUUID()}.json.claim-${dead}`;
    placeFile(path.join(config.dataDir, "obs-journal"), name, "{}");
  }
  await obsRetryBacklog();
  assert.equal(journalFiles(config.dataDir).length, JOURNAL_MAX_ENTRIES);
  const log = readFileSync(path.join(config.dataDir, "daemon.log"), "utf8");
  assert.match(log, /no policy lease for this key/);
  assert.match(log, /dropped 1 journaled event/);
  await obsFlushAll();
  await provider.shutdown();
});

test("a hook process that parks an event keeps the journal within its cap (#200)", async () => {
  installHooks();
  const lease = switchableLease();
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: lease.fetch });
  const config = { ...testConfig(), dataDir: mkdtempSync(path.join(tmpdir(), "aq-hookcap-")) };
  const now = Date.now();
  const dead = deadPid();
  for (let i = 0; i < JOURNAL_MAX_ENTRIES; i++) {
    const name = `${now - 60_000 + i}-0-${"c".repeat(64)}-${randomUUID()}.json.claim-${dead}`;
    placeFile(path.join(config.dataDir, "obs-journal"), name, "{}");
  }
  await observeHook("SessionStart", { session_id: "sess-hookcap" }, null, config);
  await obsFlush("sess-hookcap", config);
  assert.equal(journalFiles(config.dataDir).length, JOURNAL_MAX_ENTRIES);
  await provider.shutdown();
});

test("a hook process journals an event it could not record, and a daemon records it (#200)", async () => {
  installHooks();
  const lease = switchableLease();
  __setOtelTestHooksForTests({ tracerProvider: provider, leaseFetcher: lease.fetch });
  const config = { ...testConfig(), dataDir: mkdtempSync(path.join(tmpdir(), "aq-hookpark-")) };
  await observeHook("SessionStart", { session_id: "sess-hook-park" }, null, config);
  await obsFlush("sess-hook-park", config);
  assert.equal(spans().length, 0);
  assert.equal(journalFiles(config.dataDir).length, 1);
  __resetObsForTests();
  lease.up = true;
  await obsServeAsDaemon(config);
  await obsFlushAll();
  assert.deepEqual(rootSessions(), ["sess-hook-park"]);
  assert.deepEqual(journalFiles(config.dataDir), []);
  await provider.shutdown();
});

test("a running daemon adopts the journal of a process that died after it started (#194)", async () => {
  installHooks();
  const config = { ...testConfig(), dataDir: mkdtempSync(path.join(tmpdir(), "aq-adopt-")) };
  await obsServeAsDaemon(config);
  const { spoolBinding } = new armoriqSdk.ArmorIQTelemetryRuntime({
    backendEndpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    sdkVersion: "test",
  });
  const at = Date.now();
  const record = { event: "SessionStart", at, input: { session_id: "sess-orphan" } };
  const name = `${at}-0-${spoolBinding}-00000000-0000-4000-8000-000000000000.json.claim-${deadPid()}`;
  placeFile(path.join(config.dataDir, "obs-journal"), name, JSON.stringify(record));
  await obsRetryBacklog();
  await obsFlushAll();
  assert.deepEqual(rootSessions(), ["sess-orphan"]);
  assert.deepEqual(journalFiles(config.dataDir), []);
  await provider.shutdown();
});

test("a replay pass holds at most 16 sessions open and releases each one it replayed (#194)", async () => {
  installHooks();
  const config = { ...testConfig(), dataDir: mkdtempSync(path.join(tmpdir(), "aq-slots-")) };
  const { spoolBinding } = new armoriqSdk.ArmorIQTelemetryRuntime({
    backendEndpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    sdkVersion: "test",
  });
  const at = Date.now() - 10_000;
  const dead = deadPid();
  for (let i = 0; i < 40; i++) {
    for (const [n, event] of ["SessionStart", "UserPromptSubmit"].entries()) {
      const record = { event, at: at + i, input: { session_id: `sess-slot-${i}` } };
      const id = `00000000-0000-4000-8000-${String(i * 2 + n).padStart(12, "0")}`;
      const name = `${at + i}-${n}-${spoolBinding}-${id}.json.claim-${dead}`;
      placeFile(path.join(config.dataDir, "obs-journal"), name, JSON.stringify(record));
    }
  }
  let most = 0;
  const sample = setInterval(() => (most = Math.max(most, __openSessionsForTests())), 1);
  await obsServeAsDaemon(config);
  const until = Date.now() + 10_000;
  while (journalFiles(config.dataDir).length > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  clearInterval(sample);
  assert.ok(most <= 16, `${most} sessions open at once`);
  assert.equal(rootSessions().length, 40);
  assert.equal(__openSessionsForTests(), 0, "every replayed session was released");
  await obsFlushAll();
  await provider.shutdown();
});
