import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as intent from "../scripts/lib/intent.mjs";
import { idempotencyKey } from "../scripts/lib/plan-request.mjs";
import { handlePreToolUse, handleStop } from "../scripts/lib/engine.mjs";
import {
  loadRuntimeState,
  recordHookActivity,
  retirePlan,
  startPrompt,
  syncSessionAuth,
  updateRuntimeState,
} from "../scripts/lib/runtime-state.mjs";
import { loadConfigWithLogins } from "./helpers/login-profile.mjs";
import { mockTokenBackend } from "./helpers/hook-session.mjs";

const now = 1_800_000_000_000;
const plan = { steps: [{ action: "Write" }], metadata: { goal: "write notes" } };
const parentId = "11111111-1111-4111-8111-111111111111";
const refreshId = "22222222-2222-4222-8222-222222222222";

function issued(id, kind, validity = 180) {
  return {
    success: true,
    plan_id: id,
    kind,
    intent_reference: "refresh-test",
    plan_hash: "signed-plan-hash",
    token: { issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + validity },
    step_proofs: [],
  };
}

async function session(t, handler = () => [200, issued(refreshId, "refresh")], patch = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aq-refresh-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = {
    ...loadConfigWithLogins([], { CLAUDE_PLUGIN_DATA: dataDir }),
    apiKey: "ak_test_refresh0000000000000000000",
    signedOut: false,
    mode: "enforce",
    backendEndpoint: "http://127.0.0.1:1",
    csrgEndpoint: "http://127.0.0.1:1",
    csrgVerifyEnabled: false,
    daemonEnabled: false,
    auditEnabled: false,
    validitySeconds: 180,
    ...patch,
  };
  const sessionId = randomUUID();
  const requests = mockTokenBackend(t, (request, count) =>
    count === 1 ? [200, issued(parentId, "new", config.validitySeconds)] : handler(request, count)
  );
  t.mock.method(globalThis, "fetch", async () => Response.json({ orgId: "org-test", agents: [] }));
  await recordHookActivity({ session_id: sessionId }, config, process.ppid);
  await startPrompt({ session_id: sessionId, prompt: "write notes" }, config);
  const registration = await intent.registerIntentPlan(config, plan);
  assert.notEqual(registration.isError, true, registration.content[0].text);
  return {
    config,
    sessionId,
    requests,
    state: async () => (await loadRuntimeState(config.runtimeFile)).sessions[sessionId],
    change: (change) =>
      updateRuntimeState(config.runtimeFile, (state) => change(state.sessions[sessionId])),
  };
}

function loop(t, config) {
  let pending;
  const schedule = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback, ms) =>
    schedule(() => {
      pending = callback();
    }, ms)
  );
  const stop = intent.startIntentRefreshLoop(() => config);
  t.after(stop);
  return async (ms = 15_000) => {
    t.mock.timers.tick(ms);
    await pending;
  };
}

// regression: #0007
test("fast path tools leave runtime state untouched", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aq-fastpath-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfigWithLogins([], { CLAUDE_PLUGIN_DATA: dataDir });
  await startPrompt({ session_id: "fast", prompt: "read source" }, config);
  const before = await readFile(config.runtimeFile, "utf8");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 1000 });
  for (const tool_name of [
    "Read",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
    "ToolSearch",
    "TodoWrite",
    "ExitPlanMode",
  ]) {
    assert.equal(
      await handlePreToolUse({ session_id: "fast", tool_name, tool_input: {} }, config),
      null
    );
    assert.equal(await readFile(config.runtimeFile, "utf8"), before, tool_name);
  }
});

// regression: #0007
test("the 15 second loop refreshes at min(120 seconds, validity / 3) using backend expiry", async (t) => {
  for (const validitySeconds of [180, 900]) {
    await t.test(String(validitySeconds), async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
      const s = await session(t, undefined, { validitySeconds });
      const tick = loop(t, s.config);
      const expiry = new Date(now + 180_000).toISOString();
      await s.change((current) => {
        current.tokenExpiresAt = expiry;
        current.expiresAt = now / 1000 + 180;
        if (validitySeconds === 180) {
          delete current.planRequestBody;
          delete current.tokenValiditySeconds;
        }
      });
      const threshold = Math.min(120, validitySeconds / 3);
      await tick((180 - threshold) * 1000 - 15_000);
      assert.equal(s.requests.length, 1);
      await tick();
      assert.equal(s.requests.length, 2);
      const request = s.requests[1];
      assert.equal(request.headers["X-ArmorIQ-Plan-Kind"], "refresh");
      assert.equal(request.headers["X-ArmorIQ-Parent-Plan-Id"], parentId);
      assert.equal(request.headers["X-ArmorIQ-Prompt-Id"], (await s.state()).promptId);
      assert.equal(
        request.headers["Idempotency-Key"],
        idempotencyKey({ kind: "refresh", countedPlanId: parentId, tokenExpiresAt: expiry })
      );
      assert.deepEqual(request.body, s.requests[0].body);
      assert.equal((await s.state()).countedPlanId, parentId);
      assert.equal((await s.state()).tokenPlanId, refreshId);
      const reply = await intent.registerIntentPlan(s.config, plan);
      assert.match(reply.content[0].text, /Intent registered: plan .* \(new\)/);
      await handlePreToolUse(
        { session_id: s.sessionId, tool_name: "Write", tool_input: {} },
        s.config
      );
      assert.equal((await s.state()).tokenPlanId, refreshId);
      assert.equal(JSON.parse((await s.state()).intentTokenRaw).planId, refreshId);
      await tick();
      assert.equal(s.requests.length, 2);
    });
  }
});

// regression: #0007
test("closed, idle, retired, logged out and monitor sessions never refresh", async (t) => {
  for (const change of [
    "stop",
    "idle",
    "retire",
    "logout",
    "monitor",
    "other-backend",
    "other-key",
  ]) {
    await t.test(change, async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
      const s = await session(t);
      const tick = loop(t, s.config);
      if (change === "stop") await handleStop({ session_id: s.sessionId }, s.config);
      if (change === "retire") await s.change(retirePlan);
      if (change === "logout") s.config.apiKey = "";
      if (change === "monitor") s.config.mode = "monitor";
      if (change === "idle") t.mock.timers.tick(30 * 60_000);
      const before = await s.state();
      if (change === "other-backend") s.config.backendEndpoint = "https://api.armoriq.ai";
      if (change === "other-key") s.config.apiKey = "ak_test_otherwindow";
      await tick(120_000);
      assert.equal(s.requests.length, 1);
      if (change.startsWith("other-")) {
        assert.equal((await s.state()).intentTokenRaw, before.intentTokenRaw);
        assert.equal((await s.state()).authGeneration, before.authGeneration);
      }
      if (change === "idle") {
        await handlePreToolUse(
          { session_id: s.sessionId, tool_name: "Write", tool_input: {} },
          s.config
        );
        assert.equal(s.requests.length, 1);
      }
    });
  }
});

// regression: #0007
test("refresh is single flight and a late response cannot restore closed or retired state", async (t) => {
  for (const change of ["none", "stop", "idle", "prompt", "auth", "retire"]) {
    await t.test(change, async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
      const started = Promise.withResolvers();
      const release = Promise.withResolvers();
      const s = await session(t, async (request) => {
        const saved = (await s.state()).pendingRequest;
        assert.deepEqual(saved.body, request.body);
        assert.equal(saved.key, request.headers["Idempotency-Key"]);
        started.resolve();
        await release.promise;
        return [200, issued(refreshId, "refresh")];
      });
      const tick = loop(t, s.config);
      const refreshing = tick(120_000);
      await started.promise;
      const duplicate = tick();
      if (change === "stop") await handleStop({ session_id: s.sessionId }, s.config);
      if (change === "idle") t.mock.timers.tick(30 * 60_000);
      if (change === "prompt")
        await startPrompt({ session_id: s.sessionId, prompt: "next" }, s.config);
      if (change === "auth")
        await updateRuntimeState(s.config.runtimeFile, (state) =>
          syncSessionAuth(state, { ...s.config, apiKey: "another-key" })
        );
      if (change === "retire") await s.change(retirePlan);
      release.resolve();
      await Promise.all([refreshing, duplicate]);
      assert.equal(s.requests.length, 2);
      assert.equal(
        (await s.state()).tokenPlanId,
        change === "none"
          ? refreshId
          : ["prompt", "auth", "retire"].includes(change)
            ? null
            : parentId
      );
    });
  }
});

// regression: #0007
test("the pre tool guard refreshes an expired token once and does not refresh a usable token", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t);
  t.mock.timers.tick(160_000);
  const input = { session_id: s.sessionId, tool_name: "Write", tool_input: {} };
  assert.equal(await handlePreToolUse(input, s.config), null);
  assert.equal(s.requests.length, 1);
  t.mock.timers.tick(20_000);
  assert.equal(await handlePreToolUse(input, s.config), null);
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[1].headers["X-ArmorIQ-Plan-Kind"], "refresh");
  assert.equal((await s.state()).countedPlanId, parentId);
});

// regression: #0007
test("refresh failures back off and retry the persisted descriptor", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  const s = await session(t, (_, count) =>
    count === 2
      ? [500, { error: "unavailable" }, { "retry-after": "60" }]
      : [200, issued(refreshId, "refresh")]
  );
  const tick = loop(t, s.config);
  await tick(120_000);
  const saved = (await s.state()).pendingRequest;
  assert.ok(saved);
  await tick(45_000);
  assert.equal(s.requests.length, 2);
  await tick();
  assert.equal(s.requests.length, 3);
  assert.deepEqual(s.requests[2].body, saved.body);
  assert.deepEqual(s.requests[2].headers, s.requests[1].headers);
  assert.equal((await s.state()).countedPlanId, parentId);
});

// regression: #0007
test("a failed expired token guard leaves enforcement closed and backs off before another attempt", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t, (_, count) =>
    count === 2 ? [422, { error: "refresh_mismatch" }] : [200, issued(refreshId, "refresh")]
  );
  const { loadPolicyState, savePolicyState, computePolicyHash } =
    await import("../scripts/lib/policy.mjs");
  const policyState = await loadPolicyState(s.config.policyFile);
  policyState.policy.statements.push({
    id: "hold-webfetch",
    effect: "require_approval",
    principal: { type: "agent", id: "claude-code" },
    action: { type: "tool", eq: "WebFetch" },
    resource: { type: "workspace", scope: "current" },
    conditions: [],
  });
  await savePolicyState(s.config.policyFile, policyState);
  await s.change((current) => {
    current.policyHash = computePolicyHash(policyState.policy);
  });
  s.config.intentRequired = true;
  t.mock.timers.tick(180_000);
  const input = { session_id: s.sessionId, tool_name: "Write", tool_input: {} };
  for (let i = 0; i < 2; i++) {
    assert.equal(
      (await handlePreToolUse(input, s.config))?.hookSpecificOutput?.permissionDecision,
      "deny"
    );
    assert.equal(s.requests.length, 2);
    assert.equal((await s.state()).tokenPlanId, parentId);
  }
  t.mock.timers.tick(15_000);
  assert.equal(await handlePreToolUse(input, s.config), null);
  assert.equal(s.requests.length, 3);
  assert.equal((await s.state()).countedPlanId, parentId);
  for (const change of ["policy", "compiler"]) {
    await s.change((current) => {
      if (change === "policy") current.policyHash = "old-policy-hash";
      else current.intentPolicyCompilerVersion = "old-compiler";
    });
    const output = await handlePreToolUse(input, s.config);
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /intent plan missing/);
  }
});
