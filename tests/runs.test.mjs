import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  handlePreToolUse,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit,
} from "../scripts/lib/engine.mjs";
import {
  claudeCodeProcessId,
  loadRuntimeState,
  loadRunState,
  runStateFile,
  recordHookActivity,
  updateRuntimeState,
  updateRunState,
} from "../scripts/lib/runtime-state.mjs";
import { getSdkClient, registerIntentPlan } from "../scripts/lib/intent.mjs";
import { normalizeIntentPlan } from "../scripts/lib/intent-schema.mjs";
import { loadPolicyState, savePolicyState } from "../scripts/lib/policy.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";
import { noteBackendUnreachable } from "../scripts/lib/backend-posture.mjs";
import { createAuditWal, loginTag } from "../scripts/lib/audit-wal.mjs";
import { dispatchHook } from "../scripts/hook-router.mjs";
import { flushRunReports, recordRunTool } from "../scripts/lib/runs.mjs";
import { loadConfigWithLogins, writeLoginProfiles, withHome } from "./helpers/login-profile.mjs";
import {
  API_KEY,
  claudeExecutable,
  startBackend,
  startHookSession,
  startPolicyMcp,
} from "./helpers/hook-session.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/runs-v1.json", import.meta.url)));
const plan = normalizeIntentPlan({ goal: "write notes", steps: [{ action: "Write" }] });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

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
test("run storage failures preserve prompt retirement, registration replies and session closure", async (t) => {
  for (const damage of ["corrupt", "unwritable"]) {
    for (const operation of [
      "prompt",
      "registration",
      "backend_refusal",
      "rejection",
      "stop",
      "session_end",
    ]) {
      await t.test(`${damage}: ${operation}`, async (t) => {
        const s = await session(t);
        const first = await s.prompt();
        const planId = randomUUID();
        if (["prompt", "registration", "backend_refusal"].includes(operation)) {
          t.mock.method(getSdkClient(s.config), "getIntentToken", async () => {
            if (operation === "backend_refusal") throw new Error("backend refused registration");
            return { planId, expiresAt: Date.now() / 1000 + 3600, kind: "new" };
          });
          if (operation === "prompt") {
            assert.equal((await registerIntentPlan(s.config, plan)).isError, undefined);
            assert.equal((await s.state()).sessions[s.sessionId].countedPlanId, planId);
          }
        }
        await rm(runStateFile(s.config));
        if (damage === "corrupt") await writeFile(runStateFile(s.config), "{broken");
        else await mkdir(runStateFile(s.config));
        if (operation === "prompt") {
          const second = await s.prompt("a new prompt");
          assert.notEqual(second, first);
          assert.equal((await s.state()).sessions[s.sessionId].countedPlanId, null);
          assert.equal((await s.state()).sessions[s.sessionId].intentTokenRaw, "");
        } else if (["registration", "backend_refusal"].includes(operation)) {
          const reply = await registerIntentPlan(s.config, plan);
          if (operation === "registration") {
            assert.equal(reply.isError, undefined, reply.content[0].text);
            assert.equal((await s.state()).sessions[s.sessionId].countedPlanId, planId);
          } else {
            assert.equal(reply.isError, true);
            assert.match(reply.content[0].text, /backend refused registration/);
          }
        } else if (operation === "rejection") {
          const reply = await registerIntentPlan(s.config, plan, { forceRevision: true });
          assert.equal(reply.isError, true);
          assert.match(reply.content[0].text, /no current plan in this prompt to reanchor/);
        } else if (operation === "stop") {
          assert.equal(await s.stop(), null);
          assert.equal((await s.state()).sessions[s.sessionId].promptOpenSince, null);
        } else {
          assert.equal(await handleSessionEnd({ session_id: s.sessionId }, s.config), null);
          assert.equal((await s.state()).sessions[s.sessionId], undefined);
        }
        const failures = (
          await readFile(path.join(s.config.dataDir, "audit-capture-failures.jsonl"), "utf8")
        )
          .trim()
          .split("\n")
          .map(JSON.parse);
        assert.ok(failures.length > 0);
        assert.ok(failures.every(({ code }) => code === "internal_error"));
      });
    }
  }
});

// regression: #0013
test("a reporting failure preserves a tool denial and its audit row", async (t) => {
  const s = await session(t, { auditEnabled: true });
  const id = await s.prompt();
  await rm(runStateFile(s.config));
  await mkdir(runStateFile(s.config));
  const callId = randomUUID();
  const result = await s.tool("Write", callId);
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  const wal = createAuditWal({
    dataDir: s.config.dataDir,
    login: loginTag(s.config.backendEndpoint, s.config.apiKey),
  });
  const rows = (await wal.readPending()).map(({ row }) => row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "blocked");
  assert.equal(rows[0].prompt_id, id);
  assert.notEqual(rows[0].decision_code, "internal_error");
  assert.equal(
    (await readFile(path.join(s.config.dataDir, "audit-capture-failures.jsonl"), "utf8"))
      .trim()
      .split("\n").length,
    1
  );
});

// regression: #0013
test("counted tools append durable receipts without rewriting the growing runs snapshot", async (t) => {
  const s = await session(t);
  const id = await s.prompt();
  await updateRunState(s.config, (state) => {
    for (let n = 0; n < 2000; n++) state.runs[id].tools[`earlier-${n}`] = { gated: false };
    state.runs[id].tool_calls = 2000;
  });
  const before = await readFile(runStateFile(s.config));
  const inode = (await stat(runStateFile(s.config))).ino;
  const input = {
    session_id: s.sessionId,
    tool_name: "Write",
    tool_use_id: randomUUID(),
    tool_input: {},
  };
  await recordRunTool(input, s.config, id);
  await recordRunTool(input, s.config, id);
  assert.equal((await s.run(id)).tool_calls, 2001);
  assert.equal((await s.run(id)).gated_tool_calls, 1);
  assert.deepEqual(await readFile(runStateFile(s.config)), before);
  assert.equal((await stat(runStateFile(s.config))).ino, inode);
  await s.stop();
  assert.equal((await s.run(id)).reports.at(-1).tool_calls, 2001);
});

// regression: #0013
test("run tool receipts survive concurrent appends and retain a torn tail before repair", async (t) => {
  const s = await session(t);
  const id = await s.prompt();
  const input = (tool_use_id) => ({
    session_id: s.sessionId,
    tool_use_id,
    tool_name: "Write",
    tool_input: {},
  });
  const first = randomUUID();
  await recordRunTool(input(first), s.config, id);
  const journal = `${runStateFile(s.config)}.tools.jsonl`;
  const torn = Buffer.concat([Buffer.from('{"incomplete":'), Buffer.from([0xf0, 0x9f])]);
  await appendFile(journal, torn);
  await Promise.all([
    recordRunTool(input(randomUUID()), s.config, id),
    recordRunTool(input(first), s.config, id),
  ]);
  const files = (await readdir(s.config.dataDir)).filter((name) =>
    name.startsWith(path.basename(journal) + ".incomplete.")
  );
  assert.equal(files.length, 1);
  const retained = JSON.parse(await readFile(path.join(s.config.dataDir, files[0]), "utf8"));
  assert.deepEqual(Buffer.from(retained.raw_base64 ?? "", "base64"), torn);
  assert.equal((await stat(journal)).mode & 0o777, 0o600);
  assert.equal((await s.run(id)).tool_calls, 2);
  await s.stop();
  assert.equal((await s.run(id)).reports.at(-1).tool_calls, 2);
});

// regression: #0013
test("one damaged login outbox does not block another run handoff", async (t) => {
  const s = await session(t);
  const first = await s.prompt("first login");
  await s.stop();
  const other = { ...s.config, apiKey: "ak_test_otherrun0000000000000000000" };
  await handleUserPromptSubmit({ session_id: s.sessionId, prompt: "second login" }, other);
  const second = (await s.state()).sessions[s.sessionId].promptId;
  await handleStop({ session_id: s.sessionId }, other);
  const tag = loginTag(s.config.backendEndpoint, s.config.apiKey);
  const bad = path.join(s.config.dataDir, "runs", tag);
  await mkdir(bad, { recursive: true });
  await writeFile(path.join(bad, "outbox-state.json"), "{broken");
  await flushRunReports(s.config);
  const wal = createAuditWal({
    dataDir: s.config.dataDir,
    login: loginTag(other.backendEndpoint, other.apiKey),
    stream: "runs",
  });
  assert.deepEqual(
    (await wal.readPending()).map(({ row }) => [row.run_id, row.report_seq]),
    [
      [second, 1],
      [second, 2],
    ]
  );
  assert.equal((await s.run(first)).reports.length, 2);
  assert.equal(await s.run(second), undefined);
});

// regression: #0013
test("late Stop and SessionEnd callbacks keep the prompt captured at router entry", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "aq-late-hook-home-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  t.after(async () => {
    process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });
  for (const event of ["Stop", "SessionEnd"]) {
    for (const hasPrompt of [true, false]) {
      // regression: #0013
      await t.test(`${event}: ${hasPrompt ? "open prompt" : "no prompt"}`, async (t) => {
        const s = await session(t, { daemonEnabled: true });
        const first = hasPrompt ? await s.prompt("first") : undefined;
        let second;
        await dispatchHook(
          event,
          { hook_event_name: event, session_id: s.sessionId },
          s.config,
          async ({ input }) => {
            second = await s.prompt("second");
            return event === "Stop"
              ? handleStop(input, s.config)
              : handleSessionEnd(input, s.config);
          }
        );
        assert.ok(second && second !== first);
        assert.notEqual((await s.state()).sessions[s.sessionId]?.promptOpenSince, null);
        assert.equal((await s.run(second)).ended_at, undefined);
      });
    }
  }
});

// regression: #0013
test("released runtime writers cannot erase open runs or pending receipts", async (t) => {
  const s = await session(t);
  const id = await s.prompt();
  const file = s.config.runtimeFile;
  const released = JSON.parse(await readFile(file, "utf8"));
  assert.equal(released.runs, undefined);
  await writeFile(
    file,
    JSON.stringify({
      sessions: released.sessions,
      mcpRegistry: released.mcpRegistry,
      discoveredTools: released.discoveredTools,
    })
  );
  await s.tool("Write");
  await s.stop();
  const run = await s.run(id);
  assert.equal(run.tool_calls, 1);
  assert.deepEqual(
    run.reports.map(({ report_seq }) => report_seq),
    [1, 2]
  );
  const { flushRunReports } = await import("../scripts/lib/runs.mjs");
  await flushRunReports(s.config);
  const wal = createAuditWal({
    dataDir: s.config.dataDir,
    login: loginTag(s.config.backendEndpoint, s.config.apiKey),
    stream: "runs",
  });
  assert.deepEqual(
    (await wal.readPending()).map(({ row }) => row.report_seq),
    [1, 2]
  );
});

// regression: #0013
test("recovery preserves compacted and unknown live sessions and closes startup or resume runs", async (t) => {
  for (const source of ["compact", "startup", "resume"]) {
    await t.test(source, async (t) => {
      const s = await session(t);
      const id = await s.prompt();
      await updateRuntimeState(s.config.runtimeFile, (state) => {
        state.sessions[s.sessionId].claudeProcessId = null;
      });
      await handleSessionStart({ session_id: "other", source: "startup" }, s.config);
      assert.equal((await s.run(id)).ended_at, undefined);
      await handleSessionStart({ session_id: s.sessionId, source }, s.config);
      assert.equal(Boolean((await s.run(id)).ended_at), source !== "compact");
      if (source === "compact") {
        await s.tool("Write");
        await s.stop();
        assert.equal((await s.run(id)).reports.at(-1).tool_calls, 1);
        assert.equal((await s.run(id)).reports.at(-1).end_reason, "stop");
      }
    });
  }
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

test("V2 holds make reads gated before the monitor bypass, and held calls still count", async (t) => {
  const s = await session(t, { mode: "monitor", apiKey: "ak_test_holdruns0000000000000000000" });
  const document = JSON.parse(
    await readFile(new URL("./fixtures/v2-agent-policy.json", import.meta.url))
  );
  document.statements = [
    {
      ...document.statements[2],
      match: { tool: "Read", keyTier: "exact", order: 0 },
      conditions: [],
    },
  ];
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          orgId: "test",
          agents: [
            {
              agentId: "agent-claude-code",
              name: "claude-code",
              inactive: false,
              policy: { policyId: "hold", name: "hold reads", policyHash: null, document },
              tools: [],
              members: [],
            },
          ],
        }),
        { status: 200 }
      )
  );
  const id = await s.prompt();
  await s.tool("Read");
  assert.equal((await s.run(id)).gated_tool_calls, 1);
  assert.equal((await s.run(id)).tool_calls, 1);
  await s.stop();
  assert.equal((await s.run(id)).reports.at(-1).no_plan_reason, "monitor_mode");
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
test("an expired registration cannot hold its final report on a live pid", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const s = await session(t);
  const id = await s.prompt();
  await updateRunState(s.config, (state) => {
    state.runs[id].registrations.expired = {
      outcome: "pending",
      pid: process.pid,
      deadlineAt: Date.now() - 60_001,
    };
  });
  await s.stop();
  assert.equal((await s.run(id)).reports.at(-1).end_reason, "stop");
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

test("next prompt, Stop, session end and recovery preserve final reports across reloads", async (t) => {
  const s = await session(t);
  const first = await s.prompt("interrupted");
  await s.tool("Write");
  const second = await s.prompt("next");
  assert.equal((await s.run(first)).reports.at(-1).end_reason, "next_prompt");
  await handleStop({ session_id: s.sessionId, agent_id: "child" }, s.config);
  assert.equal((await s.run(second)).ended_at, undefined);
  await s.stop();
  await s.stop();
  assert.equal((await s.run(second)).reports.length, 2);
  assert.equal((await s.run(second)).reports.at(-1).end_reason, "stop");
  const third = await s.prompt("session ends");
  await handleSessionEnd({ session_id: s.sessionId }, s.config);
  assert.equal((await s.run(third)).reports.at(-1).end_reason, "session_end");
  const fourth = await s.prompt("crashed");
  await handleSessionStart({ session_id: s.sessionId }, s.config);
  const final = (await s.run(fourth)).reports.at(-1);
  assert.equal(final.end_reason, "recovered");
  assert.ok(Date.parse(final.ended_at) >= Date.parse(final.started_at));
});

// regression: #0013
test("reason precedence follows recorded facts, and confirmed plans suppress every reason", async (t) => {
  for (const [reason, patch, tools, action] of [
    ["monitor_mode", { mode: "monitor" }, ["Write"], null],
    ["no_tool_use", {}, [], null],
    ["read_only", {}, ["Read"], null],
    ["backend_unreachable", {}, ["Write"], "offline"],
    ["request_failed", {}, ["Write"], "failed"],
    ["request_failed", {}, ["Write"], "capture_failed"],
    ["plan_rejected", {}, ["Write"], "rejected"],
    ["not_registered", {}, ["Write"], null],
    [null, {}, ["Write"], "confirmed"],
  ])
    await t.test(reason ?? "confirmed", async (t) => {
      const s = await session(t, patch);
      const id = await s.prompt();
      if (action === "offline") noteBackendUnreachable(s.config);
      for (const name of tools) await s.tool(name);
      if (["failed", "confirmed", "capture_failed"].includes(action)) {
        if (action === "capture_failed")
          t.mock.method(getSdkClient(s.config), "capturePlan", () => {
            throw new Error("capture unavailable");
          });
        t.mock.method(getSdkClient(s.config), "getIntentToken", async () => {
          if (action === "failed") throw new Error("backend refused registration");
          return { planId: randomUUID(), expiresAt: Date.now() / 1000 + 3600, kind: "new" };
        });
        await registerIntentPlan(s.config, plan);
      }
      if (action === "rejected") await registerIntentPlan(s.config, plan, { forceRevision: true });
      await s.stop();
      const final = (await s.run(id)).reports.at(-1);
      assert.equal(final.no_plan_reason ?? null, reason);
      assert.equal(final.plan_ids.length, action === "confirmed" ? 1 : 0);
    });
});

// regression: #0013
test("a pending logical registration settles before finalization without changing the next run", async (t) => {
  const s = await session(t);
  const first = await s.prompt("first");
  const entered = deferred();
  const reply = deferred();
  const planId = randomUUID();
  t.mock.method(getSdkClient(s.config), "getIntentToken", async () => {
    entered.resolve();
    return reply.promise;
  });
  const registration = registerIntentPlan(s.config, plan);
  await entered.promise;
  const conflict = await registerIntentPlan(s.config, {
    ...plan,
    metadata: { ...plan.metadata, goal: "another plan" },
  });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /still pending/);
  assert.deepEqual(
    Object.values((await s.run(first)).registrations).map(({ outcome }) => outcome),
    ["pending"]
  );
  const second = await s.prompt("second");
  assert.equal((await s.run(first)).reports.length, 1);
  reply.resolve({ planId, expiresAt: Date.now() / 1000 + 3600, kind: "new" });
  await registration;
  assert.deepEqual((await s.run(first)).reports.at(-1).plan_ids, [planId]);
  assert.equal((await s.run(first)).reports.at(-1).end_reason, "next_prompt");
  assert.equal((await s.run(second)).tool_calls, 0);
  assert.deepEqual((await s.run(second)).plan_ids, []);
  assert.equal((await s.state()).sessions[s.sessionId].countedPlanId, null);
  const retired = await registerIntentPlan(s.config, plan, { runId: first });
  assert.equal(retired.isError, true);
  assert.deepEqual((await s.run(second)).registrations, {});
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

// regression: #0013
test("MCP validation failures record local rejection for registration and reanchor", async (t) => {
  const s = await session(t);
  const home = await mkdtemp(path.join(os.tmpdir(), "aq-run-mcp-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const id = await s.prompt();
  const client = await startPolicyMcp(
    t,
    {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_PLUGIN_DATA: s.config.dataDir,
      ARMORIQ_ENV: "local",
      ARMORIQ_BACKEND_URL: s.config.backendEndpoint,
      ARMORIQ_RUN_REPORTING_ENABLED: "true",
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
    },
    s.sessionId
  );
  await recordHookActivity(
    { session_id: s.sessionId },
    s.config,
    claudeCodeProcessId(process.pid, () => ({ comm: "claude", ppid: 1 }))
  );
  for (const [name, args] of [
    ["register_intent_plan", { goal: "", steps: [] }],
    ["trust_reanchor", { updatedPlan: { goal: "invalid", steps: [] } }],
  ]) {
    assert.equal((await client.callTool({ name, arguments: args })).isError, true);
  }
  assert.deepEqual(
    Object.values((await s.run(id)).registrations).map(({ outcome }) => outcome),
    ["rejected", "rejected"]
  );
  await s.tool("Write");
  await s.stop();
  assert.equal((await s.run(id)).reports.at(-1).no_plan_reason, "plan_rejected");
  const strict = await startPolicyMcp(
    t,
    {
      HOME: home,
      PATH: process.env.PATH,
      CLAUDE_PLUGIN_DATA: s.config.dataDir,
      ARMORIQ_RUN_REPORTING_ENABLED: "false",
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
    },
    s.sessionId
  );
  const tools = (await strict.listTools()).tools;
  for (const name of ["register_intent_plan", "trust_reanchor"]) {
    const schema = tools.find((tool) => tool.name === name).inputSchema;
    for (const field of Object.values(schema.properties))
      assert.ok(!(field.anyOf ?? []).some((option) => Object.keys(option).length === 0));
  }
  await rm(runStateFile(s.config));
  await mkdir(runStateFile(s.config));
  for (const [name, args] of [
    ["register_intent_plan", {}],
    ["trust_reanchor", { updatedPlan: { goal: "", steps: [] } }],
  ]) {
    const reply = await client.callTool({ name, arguments: args });
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /^Plan not registered:/);
    assert.doesNotMatch(reply.content[0].text, /EISDIR|run state/);
  }
  await rm(s.config.runtimeFile);
  await mkdir(s.config.runtimeFile);
  const contextReply = await client.callTool({ name: "register_intent_plan", arguments: {} });
  assert.match(contextReply.content[0].text, /^Plan not registered:/);
  assert.doesNotMatch(contextReply.content[0].text, /EISDIR|run state/);
  const failuresBeforeOff = await readFile(
    path.join(s.config.dataDir, "audit-capture-failures.jsonl"),
    "utf8"
  );
  const offReply = await strict.callTool({ name: "register_intent_plan", arguments: {} });
  assert.match(offReply.content[0].text, /^Plan not registered:/);
  assert.doesNotMatch(offReply.content[0].text, /EISDIR|run state/);
  assert.equal(
    await readFile(path.join(s.config.dataDir, "audit-capture-failures.jsonl"), "utf8"),
    failuresBeforeOff
  );
});

test("the rollout switch and logged out prompts cannot enqueue reports, while monitor prompts can", async (t) => {
  const { flushRunReports } = await import("../scripts/lib/runs.mjs");
  for (const patch of [
    { runReportingEnabled: false },
    { apiKey: "" },
    { signedOut: true },
    { mode: "monitor" },
  ]) {
    const s = await session(t, patch);
    const id = await s.prompt();
    await s.stop();
    await flushRunReports(s.config);
    const wal = createAuditWal({
      dataDir: s.config.dataDir,
      login: loginTag(s.config.backendEndpoint, s.config.apiKey),
      stream: "runs",
    });
    const reports = (await wal.readPending()).map(({ row }) => row);
    assert.equal(reports.length, patch.mode === "monitor" ? 2 : 0);
    if (reports.length) assert.equal(reports.at(-1).run_id, id);
  }
});

// regression: #0013
test("run handoff errors leave audit and health delivery working and the daemon alive", async (t) => {
  const events = [];
  const backend = await startBackend({
    "POST /iap/runs/batch": (body) => [
      200,
      {
        results: body.reports.map(({ run_id, report_seq }) => ({
          run_id,
          report_seq,
          outcome: "accepted",
        })),
      },
    ],
    "POST /iap/client-events": (body) => {
      events.push(...body.events);
      return [
        200,
        { results: body.events.map(({ event_id }) => ({ event_id, outcome: "accepted" })) },
      ];
    },
  });
  const s = await startHookSession(t, backend, { ARMORIQ_RUN_REPORTING_ENABLED: "true" });
  await s.hook({ hook_event_name: "UserPromptSubmit", prompt: "record a run" });
  const binding = { backend: backend.url, keyId: loginTag(backend.url, API_KEY) };
  const options = { dataDir: s.dataDir, login: binding.keyId, binding };
  await createAuditWal(options).appendLine({
    client_row_id: randomUUID(),
    tool: "Read",
    action: "Read",
    input: {},
    status: "success",
  });
  await createAuditWal({ ...options, stream: "health" }).appendLine({
    event_id: randomUUID(),
    type: "plan_request_failed",
    queue: "health",
    count: 1,
    reason_code: "timeout",
    occurred_at: new Date().toISOString(),
  });
  await writeFile(
    path.join(s.dataDir, "runs", binding.keyId, "outbox-state.json"),
    "invalid state"
  );
  await s.hook({ hook_event_name: "Stop" });
  await backend.waitForRequest("POST /iap/audit/batch");
  await backend.waitForRequest("POST /iap/client-events");
  assert.equal(backend.auditRows.length, 1);
  assert.equal(events.length, 1);
  await s.hook({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: {},
    tool_use_id: randomUUID(),
  });
  const config = { runtimeFile: path.join(s.dataDir, "runtime.json"), runReportingEnabled: true };
  assert.equal(
    Object.values((await loadRunState(config)).runs).filter((run) => run.reports.length).length,
    1
  );
});

// regression: #0013
test("daemon sends the start at prompt submission and final at Stop under the original login", async (t) => {
  if (path.basename(process.execPath).replace(/\.exe$/, "") !== "claude") {
    const runner = await claudeExecutable();
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(
      runner,
      [
        "--test",
        "--import",
        new URL("./setup/no-network.mjs", import.meta.url).href,
        "--test-name-pattern",
        `^${t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        fileURLToPath(import.meta.url),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    assert.equal(code, 0, output);
    return;
  }
  const reports = [];
  const entered = deferred();
  const release = deferred();
  const logoutStart = deferred();
  let loggingOut = false;
  t.after(() => release.resolve());
  const backend = await startBackend({
    "POST /iap/runs/batch": async (body) => {
      reports.push(...body.reports);
      if (loggingOut) {
        for (const report of body.reports) {
          if (report.report_seq === 1) logoutStart.resolve(report.run_id);
        }
      }
      if (reports.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return [
        200,
        {
          results: body.reports.map(({ run_id, report_seq }) => ({
            run_id,
            report_seq,
            outcome: "accepted",
          })),
        },
      ];
    },
  });
  const s = await startHookSession(t, backend, { ARMORIQ_RUN_REPORTING_ENABLED: "true" });
  const prompt = s.hook({ hook_event_name: "UserPromptSubmit", prompt: "hello" });
  await entered.promise;
  await prompt;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].report_seq, 1);
  assert.equal(reports[0].ended_at, undefined);
  const current = await loadRuntimeState(path.join(s.dataDir, "runtime.json"));
  assert.equal(current.sessions[s.sessionId].promptId, reports[0].run_id);
  await s.hook({ hook_event_name: "SessionStart", source: "compact" });
  assert.equal(
    (await loadRuntimeState(path.join(s.dataDir, "runtime.json"))).sessions[s.sessionId].promptId,
    reports[0].run_id
  );
  release.resolve();
  await s.hook({ hook_event_name: "Stop" });
  await backend.waitForRequest("POST /iap/runs/batch", (body) =>
    body.reports.some((report) => report.run_id === reports[0].run_id && report.report_seq === 2)
  );
  assert.equal(reports.length, 2);
  assert.equal(reports[1].end_reason, "stop");
  const client = await startPolicyMcp(t, s.env, s.sessionId);
  await s.hook({ hook_event_name: "UserPromptSubmit", prompt: "bad plan" });
  const invalid = await client.callTool({ name: "register_intent_plan", arguments: {} });
  assert.equal(invalid.isError, true);
  await s.hook({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_use_id: randomUUID(),
    tool_input: {},
  });
  await s.hook({ hook_event_name: "Stop" });
  await backend.waitForRequest("POST /iap/runs/batch", (body) =>
    body.reports.some((report) => report.no_plan_reason === "plan_rejected")
  );
  assert.equal(reports.at(-1).no_plan_reason, "plan_rejected");
  loggingOut = true;
  await s.hook({ hook_event_name: "UserPromptSubmit", prompt: "logout during turn" });
  const originalId = (await loadRuntimeState(path.join(s.dataDir, "runtime.json"))).sessions[
    s.sessionId
  ].promptId;
  assert.equal(await logoutStart.promise, originalId);
  writeLoginProfiles(s.env.HOME, [
    { backend: backend.url, apiKey: "ak_test_otherlogin000000000000000000" },
  ]);
  await s.hook({ hook_event_name: "Stop" });
  assert.equal(reports.filter(({ run_id }) => run_id === originalId).length, 1);
  const { runsStatus } = await import("../scripts/lib/audit-wal.mjs");
  const status = await withHome(s.env.HOME, () => runsStatus(s.dataDir));
  assert.equal(status.pending, 1);
  writeLoginProfiles(s.env.HOME, [{ backend: backend.url, apiKey: API_KEY }]);
  await s.hook({ hook_event_name: "Stop" });
  await s.shutdown();
  const originalReports = reports.filter(({ run_id }) => run_id === originalId);
  assert.deepEqual(
    originalReports.map(({ report_seq }) => report_seq),
    [1, 2]
  );
  assert.equal(originalReports[1].end_reason, "stop");
  assert.equal((await withHome(s.env.HOME, () => runsStatus(s.dataDir))).pending, 0);
});

// regression: #0013
test("the daemon preserves a denied tool and its audit row when the run file is unwritable", async (t) => {
  const backend = await startBackend();
  const s = await startHookSession(t, backend, { ARMORIQ_RUN_REPORTING_ENABLED: "true" });
  const policyFile = path.join(s.dataDir, "policy.json");
  const policy = await loadPolicyState(policyFile);
  policy.policy.statements.push({
    id: "deny-write",
    effect: "forbid",
    principal: { type: "agent", id: "claude-code" },
    action: { type: "tool", eq: "Write" },
    resource: { type: "workspace", scope: "current" },
    conditions: [],
  });
  await savePolicyState(policyFile, policy);
  await s.hook({ hook_event_name: "UserPromptSubmit", prompt: "deny an unplanned write" });
  const config = { runtimeFile: path.join(s.dataDir, "runtime.json"), runReportingEnabled: true };
  await rm(runStateFile(config));
  await mkdir(runStateFile(config));
  const output = await s.hook({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_use_id: randomUUID(),
    tool_input: {},
  });
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  await s.hook({ hook_event_name: "Stop" });
  const captured = await backend.waitForRequest("POST /iap/audit/batch", (body) =>
    body.rows.some((row) => row.tool === "Write")
  );
  const row = captured.rows.find((row) => row.tool === "Write");
  assert.equal(row.status, "blocked");
  assert.notEqual(row.decision_code, "internal_error");
  assert.equal(backend.auditRows.filter((row) => row.tool === "Write").length, 1);
  assert.ok(
    (await readFile(path.join(s.dataDir, "audit-capture-failures.jsonl"), "utf8")).trim().length > 0
  );
});

// regression: #0013
test("Stop and SessionEnd release the daemon session lock while delivery is stalled", async (t) => {
  for (const hook_event_name of ["Stop", "SessionEnd"]) {
    await t.test(hook_event_name, async (t) => {
      const entered = deferred();
      const release = deferred();
      t.after(() => release.resolve());
      const backend = await startBackend({
        "POST /iap/runs/batch": async (body, request) => {
          entered.resolve(request.socket);
          await release.promise;
          return [
            200,
            {
              results: body.reports.map(({ run_id, report_seq }) => ({
                run_id,
                report_seq,
                outcome: "accepted",
              })),
            },
          ];
        },
      });
      const s = await startHookSession(t, backend, { ARMORIQ_RUN_REPORTING_ENABLED: "true" });
      await s.hook({ hook_event_name: "UserPromptSubmit", prompt: "first" });
      const socket = await entered.promise;
      await s.hook({ hook_event_name });
      assert.equal(socket.destroyed, false, "the hook waited until the delivery request timed out");
      await s.hook({ hook_event_name: "UserPromptSubmit", prompt: "second" });
      assert.equal(socket.destroyed, false, "the next prompt waited behind the network flush");
      const state = await loadRuntimeState(path.join(s.dataDir, "runtime.json"));
      assert.equal(state.sessions[s.sessionId].lastPrompt, "second");
      release.resolve();
    });
  }
});
