import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  handlePostToolUseFailure,
  handlePreToolUse,
  handleStop,
  handleUserPromptSubmit,
} from "../scripts/lib/engine.mjs";
import {
  claudeCodeProcessId,
  loadRuntimeState,
  recordHookActivity,
  resolveProcessSession,
  saveRuntimeState,
  startPrompt,
  updateRuntimeState,
  upsertSession,
} from "../scripts/lib/runtime-state.mjs";
import { getSdkClient, registerIntentPlan } from "../scripts/lib/intent.mjs";
import { loadConfigWithLogins, writeLoginProfiles } from "./helpers/login-profile.mjs";
import { startBackend, startHookSession } from "./helpers/hook-session.mjs";
import { computePolicyHash, loadPolicyState, savePolicyState } from "../scripts/lib/policy.mjs";

const plan = { goal: "write notes", steps: [{ action: "Write", metadata: { inputs: {} } }] };
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function localSession(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aq-lifecycle-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfigWithLogins([], { CLAUDE_PLUGIN_DATA: dataDir });
  return { config, sessionId: randomUUID() };
}

async function mcp(t, env, sessionId, ownedSessions = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      `
        import { spawn } from 'node:child_process';
        import { updateRuntimeState } from ${JSON.stringify(new URL("../scripts/lib/runtime-state.mjs", import.meta.url).href)};
        await updateRuntimeState(process.argv[1], state => {
          for (const id of JSON.parse(process.argv[2])) state.sessions[id].claudeProcessId = process.pid;
        });
        const server = spawn(process.execPath, [process.argv[3]], { stdio: 'inherit' });
        process.on('SIGTERM', () => server.kill());
        server.on('exit', code => process.exit(code ?? 1));
      `,
      path.join(env.CLAUDE_PLUGIN_DATA, "runtime.json"),
      JSON.stringify(ownedSessions),
      path.resolve("scripts/policy-mcp.mjs"),
    ],
    env: { ...env, ...(sessionId ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}) },
    stderr: "pipe",
  });
  const client = new Client({ name: "simulated-claude", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

// regression: #0007
test("two Claude Code MCP processes keep registrations in their own root sessions", async (t) => {
  const { config, sessionId } = await localSession(t);
  const dataDir = config.dataDir;
  const home = await mkdtemp(path.join(os.tmpdir(), "aq-mcp-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
  };
  const otherId = randomUUID();
  await handleUserPromptSubmit({ session_id: sessionId, prompt: "first window" }, config);
  await handleUserPromptSubmit({ session_id: otherId, prompt: "second window" }, config);
  const first = await mcp(t, env, sessionId, [sessionId]);
  const second = await mcp(t, env, otherId, [otherId]);
  await first.callTool({ name: "register_intent_plan", arguments: plan });
  await second.callTool({
    name: "register_intent_plan",
    arguments: { ...plan, goal: "second plan" },
  });
  const pending = (id) =>
    readFile(path.join(dataDir, `pending-plan.${id}.json`), "utf8").then(JSON.parse);
  assert.equal((await pending(sessionId)).plan.metadata.goal, plan.goal);
  assert.equal((await pending(otherId)).plan.metadata.goal, "second plan");
  const unidentified = await mcp(t, env);
  const result = await unidentified.callTool({ name: "register_intent_plan", arguments: plan });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /session identity/i);
  assert.equal((await pending(otherId)).plan.metadata.goal, "second plan");
});

// regression: #0007
test("registration selects only its process's latest root session", async (t) => {
  for (const envId of ["stale", "missing", "foreign", "child"]) {
    await t.test(envId, async (t) => {
      const { config, sessionId } = await localSession(t);
      t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
      const laterId = randomUUID();
      const foreignId = randomUUID();
      const childId = randomUUID();
      await handleUserPromptSubmit({ session_id: sessionId, prompt: "before clear" }, config);
      await recordHookActivity({ session_id: laterId }, config);
      t.mock.timers.tick(1);
      await handleUserPromptSubmit({ session_id: foreignId, prompt: "other window" }, config);
      await handleUserPromptSubmit(
        { session_id: childId, prompt: "child wakeup", parent_session_id: laterId },
        config
      );
      const state = await loadRuntimeState(config.runtimeFile);
      upsertSession(state, foreignId, { claudeProcessId: process.pid });
      await saveRuntimeState(config.runtimeFile, state);
      const home = await mkdtemp(path.join(os.tmpdir(), "aq-mcp-home-"));
      t.after(() => rm(home, { recursive: true, force: true }));
      const client = await mcp(
        t,
        {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_PLUGIN_DATA: config.dataDir,
          ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
        },
        { stale: sessionId, foreign: foreignId, child: childId }[envId],
        [sessionId, laterId, childId]
      );
      if (envId === "stale") {
        const beforeClear = await client.callTool({
          name: "register_intent_plan",
          arguments: plan,
        });
        assert.notEqual(beforeClear.isError, true, beforeClear.content[0].text);
        await rm(path.join(config.dataDir, `pending-plan.${sessionId}.json`));
      }
      t.mock.timers.tick(1);
      await handleUserPromptSubmit({ session_id: laterId, prompt: "after clear" }, config);
      const result = await client.callTool({ name: "register_intent_plan", arguments: plan });
      assert.notEqual(result.isError, true, result.content[0].text);
      assert.deepEqual(
        (await readdir(config.dataDir)).filter((name) => name.startsWith("pending-plan.")),
        [`pending-plan.${laterId}.json`]
      );
    });
  }
});

// regression: #0007
test("registration rejects an env session owned by another process", async (t) => {
  const { config, sessionId } = await localSession(t);
  await handleUserPromptSubmit({ session_id: sessionId, prompt: "other window" }, config);
  const state = await loadRuntimeState(config.runtimeFile);
  upsertSession(state, sessionId, { claudeProcessId: process.pid });
  await saveRuntimeState(config.runtimeFile, state);
  const home = await mkdtemp(path.join(os.tmpdir(), "aq-mcp-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const client = await mcp(
    t,
    {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_PLUGIN_DATA: config.dataDir,
      ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
    },
    sessionId
  );
  const result = await client.callTool({ name: "register_intent_plan", arguments: plan });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /plan (?:was )?not registered/i);
  assert.match(result.content[0].text, /session identity/i);
  assert.equal(
    (await readdir(config.dataDir)).some((name) => name.startsWith("pending-plan.")),
    false
  );
});

// regression: #0007
test("hooks find the nearest Claude Code ancestor and record session ownership", async (t) => {
  const { config, sessionId } = await localSession(t);
  const processes = new Map([
    [30, { ppid: 20, comm: "/bin/zsh" }],
    [20, { ppid: 10, comm: "/usr/local/bin/claude" }],
    [10, { ppid: 1, comm: "/opt/claude" }],
    [40, { ppid: 1, comm: "/usr/local/bin/node" }],
    [
      50,
      {
        ppid: 1,
        comm: "/usr/local/bin/node",
        args: "node /opt/node_modules/@anthropic-ai/claude-code/cli.js",
      },
    ],
    [60, { ppid: 1, comm: "/home/dev/.local/share/claude/versions/2.1.325" }],
    [
      70,
      {
        ppid: 1,
        comm: "2.1.325",
        executable: "/home/dev/.local/share/claude/versions/2.1.325",
      },
    ],
    [80, { ppid: 1, comm: "node", args: "node /opt/@anthropic-ai/claude-agent-sdk/cli.js" }],
  ]);
  const lookup = (pid) => processes.get(pid);
  assert.equal(claudeCodeProcessId(30, lookup), 20);
  assert.equal(claudeCodeProcessId(40, lookup), null);
  assert.equal(claudeCodeProcessId(50, lookup), 50);
  assert.equal(claudeCodeProcessId(60, lookup), 60);
  assert.equal(claudeCodeProcessId(70, lookup), 70);
  assert.equal(claudeCodeProcessId(80, lookup), 80);
  await recordHookActivity({ session_id: sessionId }, config, 20);
  await recordHookActivity({ session_id: sessionId }, config);
  assert.equal(
    (await loadRuntimeState(config.runtimeFile)).sessions[sessionId].claudeProcessId,
    20
  );
});

// regression: #43
test("unavailable process lookup uses the active root pointer for registration", async (t) => {
  const { config: local, sessionId } = await localSession(t);
  const config = { ...local, apiKey: "ak_test_nullprocess", mode: "enforce" };
  const planId = randomUUID();
  t.mock.method(getSdkClient(config), "getIntentToken", async () => ({
    planId,
    kind: "new",
    expiresAt: Date.now() / 1000 + 3600,
  }));
  const unknownPid = 43210;
  assert.equal(
    claudeCodeProcessId(unknownPid, () => null),
    null
  );
  await handleUserPromptSubmit({ session_id: sessionId, prompt: "write notes" }, config);
  await recordHookActivity({ session_id: sessionId }, config, null);
  await recordHookActivity({ session_id: "child", parent_session_id: sessionId }, config, null);
  let state = await loadRuntimeState(config.runtimeFile);
  assert.equal(resolveProcessSession(state, unknownPid, ""), sessionId);
  const result = await registerIntentPlan(config, plan);
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.match(result.content[0].text, new RegExp(`Intent registered: plan ${planId}`));
  assert.deepEqual(state.sessions[sessionId].claudeProcessId, null);
  await updateRuntimeState(config.runtimeFile, (current) => {
    current.sessions[sessionId].claudeProcessId = unknownPid + 1;
  });
  state = await loadRuntimeState(config.runtimeFile);
  assert.equal(resolveProcessSession(state, unknownPid, sessionId), null);
});

// regression: #362
test("two router and daemon hooks after relogin preserve the confirmed plan", async (t) => {
  const { config: local, sessionId } = await localSession(t);
  const config = { ...local, apiKey: "ak_test_relogin", mode: "enforce", signedOut: false };
  await handleUserPromptSubmit({ session_id: sessionId, prompt: "write notes" }, config);
  await updateRuntimeState(config.runtimeFile, (state) => {
    Object.assign(state.sessions[sessionId], {
      countedPlanId: randomUUID(),
      intentTokenRaw: "confirmed token",
    });
  });
  const before = (await loadRuntimeState(config.runtimeFile)).sessions[sessionId];
  for (let i = 0; i < 2; i++) {
    await recordHookActivity({ session_id: sessionId }, config);
    await recordHookActivity({ session_id: sessionId }, { ...config, signedOut: true });
    const after = (await loadRuntimeState(config.runtimeFile)).sessions[sessionId];
    assert.equal(after.authGeneration, before.authGeneration);
    assert.equal(after.countedPlanId, before.countedPlanId);
    assert.equal(after.intentTokenRaw, before.intentTokenRaw);
  }
});

// regression: #294
test("verification preserves newly minted and refreshed prompt tokens", async (t) => {
  for (const phase of ["mint", "refresh", "retire"]) {
    await t.test(phase, async (t) => {
      const { config: localConfig, sessionId } = await localSession(t);
      const config = {
        ...localConfig,
        apiKey: "ak_test_lifecycle000000000000000000",
        signedOut: false,
        mode: "enforce",
        backendEndpoint: "http://127.0.0.1:1",
        csrgEndpoint: "http://127.0.0.1:1",
        verifyStepEndpoint: "http://127.0.0.1:1/iap/verify-step",
        csrgVerifyEnabled: true,
        daemonEnabled: false,
      };
      const planId = randomUUID();
      const token = { planId, expiresAt: Date.now() / 1000 + 3600, rawToken: { plan } };
      t.mock.method(getSdkClient(config), "getIntentToken", async () => token);
      t.mock.method(globalThis, "fetch", async (url) => {
        if (phase === "retire" && String(url).includes("verify-step"))
          await startPrompt({ session_id: sessionId, prompt: "next prompt" }, config);
        return new Response(
          JSON.stringify(
            String(url).includes("/policy/bundles/")
              ? { orgId: "org-test", agents: [] }
              : { allowed: true }
          ),
          { status: 200 }
        );
      });
      const previousToken = JSON.stringify({ ...token, planId: randomUUID() });
      await handleUserPromptSubmit({ session_id: sessionId, prompt: "previous prompt" }, config);
      const previous = await loadRuntimeState(config.runtimeFile);
      const { policy } = await loadPolicyState(config.policyFile);
      upsertSession(previous, sessionId, {
        plan,
        intentTokenRaw: previousToken,
        expiresAt: token.expiresAt,
        policyHash: computePolicyHash(policy),
        intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
      });
      await saveRuntimeState(config.runtimeFile, previous);
      await handleUserPromptSubmit({ session_id: sessionId, prompt: "write notes" }, config);
      await recordHookActivity({ session_id: sessionId }, config, process.ppid);
      const registration = await registerIntentPlan(config, plan);
      assert.notEqual(registration.isError, true, registration.content[0].text);
      if (phase === "refresh") {
        const state = await loadRuntimeState(config.runtimeFile);
        upsertSession(state, sessionId, {
          plan,
          intentTokenRaw: previousToken,
          expiresAt: Date.now() / 1000 - 1,
          tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
          policyHash: computePolicyHash(policy),
          intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
        });
        await saveRuntimeState(config.runtimeFile, state);
      }
      const input = {
        session_id: sessionId,
        tool_name: "Write",
        tool_input: {},
        intentTokenRaw: previousToken,
      };
      assert.notEqual(
        (await handlePreToolUse(input, config))?.hookSpecificOutput?.permissionDecision,
        "deny"
      );
      assert.equal(
        (await loadRuntimeState(config.runtimeFile)).sessions[sessionId].intentTokenRaw,
        phase === "retire" ? "" : JSON.stringify(token)
      );
    });
  }
});

test("root prompts get UUIDs, deduplicate for five seconds, and close at Stop", async (t) => {
  const { config, sessionId } = await localSession(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const prompt = (text, extra = {}) =>
    handleUserPromptSubmit({ session_id: sessionId, prompt: text, ...extra }, config);
  const session = async () => (await loadRuntimeState(config.runtimeFile)).sessions[sessionId];
  await prompt("first");
  const first = await session();
  assert.match(first.promptId, uuidV4);
  assert.equal(first.promptGeneration, 1);
  t.mock.timers.tick(4999);
  await prompt("first");
  assert.equal((await session()).promptId, first.promptId);
  assert.equal((await session()).promptOpenSince, first.promptOpenSince);
  t.mock.timers.tick(2);
  await prompt("first");
  assert.notEqual((await session()).promptId, first.promptId);
  await prompt("second");
  const second = await session();
  assert.equal(second.promptGeneration, 3);
  await prompt("agent wakeup", { agent_id: "child" });
  assert.equal((await session()).promptId, second.promptId);
  await handleStop({ session_id: sessionId, parent_session_id: "parent" }, config);
  assert.equal((await session()).promptOpenSince, second.promptOpenSince);
  await handleStop({ session_id: sessionId }, config);
  assert.equal((await session()).promptOpenSince, null);
  assert.ok((await session()).lastActivityAt >= second.lastActivityAt);
  await prompt("");
  assert.notEqual((await session()).promptId, second.promptId);
  assert.equal((await session()).promptGeneration, 4);
});

test("a new prompt retires the previous plan and rejects late prompt and auth responses", async (t) => {
  const { config, sessionId } = await localSession(t);
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const prompt = (text, cfg = config) =>
    handleUserPromptSubmit({ session_id: sessionId, prompt: text }, cfg);
  await prompt("first");
  const state = await loadRuntimeState(config.runtimeFile);
  upsertSession(state, sessionId, {
    plan,
    intentTokenRaw: "old token",
    expiresAt: 2_000_000_000,
    countedPlanId: "old counted plan",
    tokenPlanId: "old token plan",
    pendingRequest: { key: "old request" },
  });
  await saveRuntimeState(config.runtimeFile, state);
  const stalePromptResponse = await loadRuntimeState(config.runtimeFile);
  await prompt("second");
  upsertSession(stalePromptResponse, sessionId, { plan, intentTokenRaw: "late prompt token" });
  await saveRuntimeState(config.runtimeFile, stalePromptResponse);
  let current = (await loadRuntimeState(config.runtimeFile)).sessions[sessionId];
  assert.equal(current.intentTokenRaw, "");
  assert.equal(current.countedPlanId, null);
  assert.equal(current.tokenPlanId, null);
  assert.equal(current.pendingRequest, null);
  const staleAuthResponse = await loadRuntimeState(config.runtimeFile);
  await prompt("second", { ...config, apiKey: "a different key", mode: "enforce" });
  upsertSession(staleAuthResponse, sessionId, { plan, intentTokenRaw: "late auth token" });
  await saveRuntimeState(config.runtimeFile, staleAuthResponse);
  current = (await loadRuntimeState(config.runtimeFile)).sessions[sessionId];
  assert.equal(current.intentTokenRaw, "");
  assert.equal(current.promptGeneration, staleAuthResponse.sessions[sessionId].promptGeneration);
  assert.ok(current.authGeneration > staleAuthResponse.sessions[sessionId].authGeneration);
});

test("key, mode and org changes retire every session on any hook", async (t) => {
  const { config, sessionId } = await localSession(t);
  await handleUserPromptSubmit(
    { session_id: sessionId, prompt: "first" },
    {
      ...config,
      apiKey: "ak_test_sameprefix111111111111111111",
      mode: "enforce",
    }
  );
  const otherConfig = {
    ...config,
    backendEndpoint: "https://other-backend.invalid",
    apiKey: "ak_live_other",
  };
  await handleUserPromptSubmit(
    { session_id: "other-backend", prompt: "other window" },
    otherConfig
  );
  await updateRuntimeState(config.runtimeFile, (state) => {
    state.sessions["other-backend"].intentTokenRaw = "other token";
  });

  const configs = [
    { ...config, apiKey: "ak_test_sameprefix222222222222222222", mode: "enforce" },
    { ...config, apiKey: "ak_test_sameprefix222222222222222222", mode: "monitor" },
    {
      ...config,
      apiKey: "ak_test_sameprefix222222222222222222",
      mode: "monitor",
      orgId: "another org",
    },
  ];
  for (const cfg of configs) {
    const before = await loadRuntimeState(config.runtimeFile);
    upsertSession(before, sessionId, {
      plan,
      intentTokenRaw: "old auth token",
      pendingRequest: { key: "pending" },
    });
    await saveRuntimeState(config.runtimeFile, before);
    await handlePostToolUseFailure({ session_id: "other root", tool_name: "Read" }, cfg);
    const after = (await loadRuntimeState(config.runtimeFile)).sessions[sessionId];
    assert.equal(after.intentTokenRaw, "");
    assert.equal(after.pendingRequest, null);
    assert.equal(after.authGeneration, before.sessions[sessionId].authGeneration + 1);
    assert.equal(
      (await loadRuntimeState(config.runtimeFile)).sessions["other-backend"].intentTokenRaw,
      "other token"
    );
  }
  const before = (await loadRuntimeState(config.runtimeFile)).sessions[sessionId];
  await recordHookActivity(
    { session_id: sessionId },
    { ...configs.at(-1), backendEndpoint: "http://localhost:8000" }
  );
  const after = (await loadRuntimeState(config.runtimeFile)).sessions[sessionId];
  assert.equal(after.authGeneration, before.authGeneration + 1);
  assert.equal(after.authBackendEndpoint, "http://localhost:8000");
});

test("the directive requires registration before the first tool that needs a plan", async (t) => {
  const { config, sessionId } = await localSession(t);
  const output = await handleUserPromptSubmit(
    { session_id: sessionId, prompt: "hello" },
    {
      ...config,
      planningEnabled: true,
      intentRequired: true,
    }
  );
  const directive = output.hookSpecificOutput.additionalContext;
  assert.match(directive, /before the first tool that needs (?:a plan|one)/i);
  assert.doesNotMatch(directive, /before using any tool|before any other tool call/i);
  assert.doesNotMatch(directive, /plan file/i);
});

test("a previous prompt cannot authorize a Write and logout retires all plan state", async (t) => {
  const backend = await startBackend();
  const { env, dataDir, sessionId, hook } = await startHookSession(t, backend);
  const policyFile = path.join(dataDir, "policy.json");
  const policyState = await loadPolicyState(policyFile);
  policyState.policy.statements.push({
    id: "hold-webfetch",
    effect: "require_approval",
    principal: { type: "agent", id: "claude-code" },
    action: { type: "tool", eq: "WebFetch" },
    resource: { type: "workspace", scope: "current" },
    conditions: [],
  });
  await savePolicyState(policyFile, policyState);
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "first" });
  const file = path.join(dataDir, "runtime.json");
  const state = await loadRuntimeState(file);
  upsertSession(state, sessionId, { plan, intentTokenRaw: "old token", countedPlanId: "old" });
  await saveRuntimeState(file, state);
  await writeFile(
    path.join(dataDir, `pending-plan.${sessionId}.json`),
    JSON.stringify({
      sessionId,
      plan,
      tokenRaw: "previous prompt token",
      promptGeneration: state.sessions[sessionId].promptGeneration,
      authGeneration: state.sessions[sessionId].authGeneration,
      intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
    })
  );
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "second" });
  const output = await hook({ hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {} });
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /intent plan missing/i);
  const beforeLogout = await loadRuntimeState(file);
  upsertSession(beforeLogout, sessionId, { plan, intentTokenRaw: "logout token" });
  await saveRuntimeState(file, beforeLogout);
  await rm(path.join(env.HOME, ".armoriq", "credentials.json"));
  await hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} });
  const afterLogout = (await loadRuntimeState(file)).sessions[sessionId];
  assert.equal(afterLogout.intentTokenRaw, "");
  assert.ok(afterLogout.authGeneration > beforeLogout.sessions[sessionId].authGeneration);
  writeLoginProfiles(env.HOME, [
    { backend: backend.url, apiKey: "ak_test_newlogin00000000000000000000" },
  ]);
  await hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} });
  assert.ok(
    (await loadRuntimeState(file)).sessions[sessionId].authGeneration > afterLogout.authGeneration
  );
});

test("concurrent runtime writers preserve different sessions and fields in one session", async (t) => {
  const { config } = await localSession(t);
  const workers = Array.from({ length: 6 }, (_, i) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { loadRuntimeState, saveRuntimeState, upsertSession } from ${JSON.stringify(new URL("../scripts/lib/runtime-state.mjs", import.meta.url).href)};
      const file = process.argv[1];
      const id = process.argv[2];
      const state = await loadRuntimeState(file);
      process.send('ready');
      process.once('message', async () => {
        upsertSession(state, id, { value: id });
        upsertSession(state, 'shared', { ['writer' + id]: true });
        await saveRuntimeState(file, state);
        process.disconnect();
      });
    `,
        config.runtimeFile,
        String(i),
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"] }
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    return child;
  });
  await Promise.all(workers.map((child) => once(child, "message")));
  const exits = workers.map((child) => once(child, "exit"));
  for (const child of workers) child.send("write");
  assert.deepEqual(
    (await Promise.all(exits)).map(([code]) => code),
    Array(6).fill(0)
  );
  const { sessions } = await loadRuntimeState(config.runtimeFile);
  assert.equal(Object.keys(sessions).length, 7);
  for (let i = 0; i < 6; i++) assert.equal(sessions.shared[`writer${i}`], true);
  await writeFile(`${config.runtimeFile}.lock`, String(workers[0].pid));
  const recovered = await loadRuntimeState(config.runtimeFile);
  upsertSession(recovered, "after-crash", { recovered: true });
  await saveRuntimeState(config.runtimeFile, recovered);
  assert.equal(
    (await loadRuntimeState(config.runtimeFile)).sessions["after-crash"].recovered,
    true
  );
  const holder = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { link, writeFile } from 'node:fs/promises';
    const owner = process.argv[1] + '.lock.' + process.pid + '.holder';
    await writeFile(owner, JSON.stringify({ pid: process.pid, expiresAt: Date.now() + 1000 }));
    await link(owner, process.argv[1] + '.lock');
    await link(owner, process.argv[1] + '.lock.reclaim');
    process.send('held');
    process.on('message', () => {});
  `,
      config.runtimeFile,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }
  );
  t.after(() => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
  });
  await once(holder, "message");
  const killed = once(holder, "exit");
  holder.kill("SIGKILL");
  await killed;
  let lockTime = 0;
  t.mock.method(performance, "now", () => (lockTime += 1000));
  await recordHookActivity({ session_id: "after-reclaim-crash" }, config);
  assert.ok((await loadRuntimeState(config.runtimeFile)).sessions["after-reclaim-crash"]);
  assert.equal(
    (await readdir(config.dataDir)).some((name) => name.startsWith("runtime.json.lock")),
    false
  );
  await writeFile(
    `${config.runtimeFile}.lock.expired`,
    JSON.stringify({ pid: process.pid, expiresAt: Date.now() - 1 })
  );
  await link(`${config.runtimeFile}.lock.expired`, `${config.runtimeFile}.lock.reclaim`);
  await writeFile(`${config.runtimeFile}.lock`, String(workers[0].pid));
  await recordHookActivity({ session_id: "after-expiry" }, config);
  assert.ok((await loadRuntimeState(config.runtimeFile)).sessions["after-expiry"]);
});
