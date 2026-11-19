import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePreToolUse, handleStop, handleUserPromptSubmit } from "../scripts/lib/engine.mjs";
import {
  loadRuntimeState,
  loadRunState,
  runStateFile,
  recordHookActivity,
  updateRunState,
} from "../scripts/lib/runtime-state.mjs";
import { loadPolicyState, savePolicyState } from "../scripts/lib/policy.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";
import { createAuditWal, loginTag } from "../scripts/lib/audit-wal.mjs";
import { loadConfigWithLogins } from "./helpers/login-profile.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/runs-v1.json", import.meta.url)));

async function session(t, patch = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aq-runs-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = {
    ...loadConfigWithLogins([], { CLAUDE_PLUGIN_DATA: dataDir }),
    apiKey: "ak_test_runs000000000000000000000000",
    backendEndpoint: "http://127.0.0.1:1",
    mode: "enforce",
    intentRequired: true,
    runReportingEnabled: true,
    auditEnabled: false,
    cryptoPolicyEnabled: false,
    autoRevokeOnEnd: false,
    daemonEnabled: false,
    ...patch,
  };
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ orgId: "test", agents: [] }), { status: 200 })
  );
  const policy = await loadPolicyState(config.policyFile);
  policy.policy.statements.push({
    id: "no-glob",
    effect: "forbid",
    principal: { type: "agent", id: "claude-code" },
    action: { type: "tool", eq: "Glob" },
    resource: { type: "workspace", scope: "current" },
    conditions: [],
  });
  await savePolicyState(config.policyFile, policy);
  const sessionId = randomUUID();
  await recordHookActivity({ session_id: sessionId }, config, process.ppid);
  const state = () => loadRuntimeState(config.runtimeFile);
  const prompt = async (text = "write notes") => {
    await handleUserPromptSubmit({ session_id: sessionId, prompt: text }, config);
    return (await state()).sessions[sessionId].promptId;
  };
  const tool = (tool_name, tool_use_id = randomUUID(), extra = {}) =>
    handlePreToolUse(
      { session_id: sessionId, tool_name, tool_use_id, tool_input: {}, ...extra },
      config
    );
  const stop = () => handleStop({ session_id: sessionId }, config);
  return {
    config,
    sessionId,
    state,
    prompt,
    tool,
    stop,
    run: async (id) => (await loadRunState(config)).runs?.[id],
  };
}

test("prompt start persists its identity and first report before any tool", async (t) => {
  const s = await session(t);
  const id = await s.prompt();
  const run = await s.run(id);
  assert.ok(run, "the prompt must have a durable run");
  assert.equal(run.run_id, id);
  assert.equal(run.session_id, s.sessionId);
  assert.equal(run.login.keyId, loginTag(s.config.backendEndpoint, s.config.apiKey));
  assert.deepEqual(run.reports, [
    {
      run_id: id,
      report_seq: 1,
      session_id: s.sessionId,
      started_at: run.started_at,
      tool_calls: 0,
      gated_tool_calls: 0,
      plan_ids: [],
    },
  ]);
  await s.prompt();
  assert.equal((await s.run(id)).reports.length, 1);
});

// regression: #0013
test("counts root attempts once, including blocked tools, and excludes trusted own tools and children", async (t) => {
  const s = await session(t);
  const id = await s.prompt();
  const callId = randomUUID();
  assert.equal((await s.tool("Write", callId)).hookSpecificOutput.permissionDecision, "deny");
  await s.tool("Write", callId);
  await s.tool("Read");
  await s.tool("mcp__armorclaude-policy__register_intent_plan");
  await s.tool("mcp__plugin_armorclaude_armorclaude-policy__trust_reanchor");
  await s.tool("policy_read");
  await s.tool("Write", randomUUID(), { agent_id: "child" });
  await s.tool("Write", randomUUID(), { parent_session_id: s.sessionId });
  await s.tool("Write", randomUUID(), { is_subagent: true });
  await s.tool("mcp__untrusted__policy_read");
  const run = await s.run(id);
  assert.equal(run.tool_calls, 3);
  assert.equal(run.gated_tool_calls, 2);
  await s.stop();
  assert.equal((await s.run(id)).reports.at(-1).no_plan_reason, "not_registered");
});

// regression: #0013
test("a failed tool check still counts the root attempt", async (t) => {
  const s = await session(t);
  const id = await s.prompt();
  // An unreadable policy file is answered as a policy_file_invalid verdict, not thrown.
  await handlePreToolUse(
    { session_id: s.sessionId, tool_name: "Read", tool_input: {}, tool_use_id: randomUUID() },
    { ...s.config, policyFile: s.config.dataDir }
  );
  assert.equal((await s.run(id)).tool_calls, 1);
});

test("capabilities and wire constants agree with conmap-auto's contract", async () => {
  const { RUNS_CONTRACT, classifyRunTool } = await import("../scripts/lib/runs.mjs");
  assert.deepEqual(RUNS_CONTRACT, {
    endReasons: fixture.endReasons,
    noPlanReasons: fixture.noPlanReasons,
    limits: fixture.limits,
    capability: fixture.capabilities.armorclaude,
    hooks: fixture.adapterHooks.armorclaude,
  });
  for (const [name, input, action, expected] of [
    [" Read ", {}, "allow", false],
    ["Read", {}, "hold", true],
    ["WebFetch", {}, "hold", true],
    ["ToolSearch", {}, "allow", false],
    ["Skill", { skill: "armorclaude:armor" }, "allow", false],
    ["Skill", { skill: "other" }, "allow", true],
    ["LS", {}, "allow", true],
    ["NotebookRead", {}, "allow", true],
    ["Bash", {}, "allow", true],
    ["mcp__evil__trust_reanchor", {}, "allow", true],
  ])
    assert.equal(classifyRunTool(name, input, action).gated, expected, name);
});

test("the next prompt finalizes an interrupted registration whose process died", async (t) => {
  const s = await session(t);
  const id = await s.prompt("crash during registration");
  await updateRunState(s.config, (state) => {
    state.runs[id].registrations.interrupted = { outcome: "pending", pid: 2147483647 };
  });
  await s.prompt("next after crash");
  assert.equal((await s.run(id)).reports.at(-1).end_reason, "next_prompt");
});

// regression: #0013
test("the off switch never reads an unreadable run store", async (t) => {
  const s = await session(t, { runReportingEnabled: false });
  await writeFile(runStateFile(s.config), "invalid state");
  const id = await s.prompt();
  assert.equal((await s.tool("Write")).hookSpecificOutput.permissionDecision, "deny");
  await s.stop();
  const { flushRunReports } = await import("../scripts/lib/runs.mjs");
  await flushRunReports(s.config);
  assert.deepEqual(await loadRunState(s.config), { runs: {} });
  assert.equal(await s.run(id), undefined);
  assert.equal(await readFile(runStateFile(s.config), "utf8"), "invalid state");
});

test("durable handoff retains the original login after logout and exposes pending reports locally", async (t) => {
  const { flushRunReports } = await import("../scripts/lib/runs.mjs");
  const s = await session(t);
  const id = await s.prompt();
  await s.tool("Write");
  const loggedOut = { ...s.config, apiKey: "", signedOut: true };
  await handleStop({ session_id: s.sessionId }, loggedOut);
  await flushRunReports(loggedOut);
  const login = loginTag(s.config.backendEndpoint, s.config.apiKey);
  const wal = createAuditWal({ dataDir: s.config.dataDir, login, stream: "runs" });
  const entries = await wal.readPending();
  assert.equal(entries.length, 2);
  assert.equal(entries[1].row.run_id, id);
  assert.deepEqual(entries[1].login, { backend: s.config.backendEndpoint, keyId: login });
  const text = await handleArmorPolicyCommand("/armor status", loggedOut);
  assert.match(text, /Pending run reports: 2/);
  assert.match(text, /Run reporting paused: yes/);
  assert.equal((await loadRunState(s.config)).runs[id], undefined);
});
