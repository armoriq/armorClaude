import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { computePolicyHash, savePolicyState } from "../scripts/lib/policy.mjs";
import { noteBackendUnreachable } from "../scripts/lib/backend-posture.mjs";
import {
  handlePreToolUse,
  handlePostToolUse,
  handlePostToolUseFailure,
} from "../scripts/lib/engine.mjs";
import { captureSession } from "./helpers/audit-capture.mjs";
import armoriqSdk from "@armoriq/sdk";
import { loadPolicyState } from "../scripts/lib/policy.mjs";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";

const PLAN_ID = randomUUID();
const PLAN = {
  goal: "read the repo",
  steps: [
    { action: "Read", mcp: "claude-code" },
    { action: "Glob", mcp: "claude-code" },
  ],
};

const statement = (id, effect, tool) => ({
  id,
  effect,
  principal: { type: "agent", id: "claude-code" },
  action: { type: "tool", eq: tool },
  resource: { type: "workspace", scope: "current" },
  conditions: [],
});

async function enforcingSession(t, { withPlan = false } = {}) {
  const backend = await startBackend();
  const session = await startHookSession(t, backend);
  await savePolicyState(path.join(session.dataDir, "policy.json"), {
    version: 1,
    policy: {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "blocked-rows", description: "" },
      defaults: { decision: "allow", conflictResolution: "deny_overrides" },
      statements: [
        statement("hold-webfetch", "require_approval", "WebFetch"),
        statement("no-glob", "forbid", "Glob"),
      ],
    },
  });
  if (withPlan) await registerPlan(session);
  return { ...session, backend };
}

async function registerPlan({ dataDir, sessionId }) {
  const token = {
    tokenId: "intent-ref",
    planHash: "plan-hash",
    planId: PLAN_ID,
    signature: "sig",
    issuedAt: 1,
    expiresAt: 4_102_444_800,
    policy: {},
    compositeIdentity: "",
    stepProofs: [],
    totalSteps: PLAN.steps.length,
    rawToken: { plan: PLAN, plan_id: PLAN_ID, token: {}, plan_hash: "plan-hash" },
    jwtToken: "eyJhbGciOiJFUzI1NiJ9.e30.sig",
  };
  await writeFile(
    path.join(dataDir, "runtime.json"),
    JSON.stringify({
      sessions: {
        [sessionId]: {
          intentTokenRaw: JSON.stringify(token),
          plan: PLAN,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    })
  );
}

async function blockedRow({ backend, hook }, call, code) {
  const out = await hook({ hook_event_name: "PreToolUse", ...call });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.auditRows.length === 1, 15_000, "the blocked row");
  const [row] = backend.auditRows;
  assert.equal(row.status, "blocked");
  assert.equal(row.tool, call.tool_name);
  assert.equal(row.error_message, code);
  assert.match(row.client_row_id, /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/);
  return row;
}

test("a call denied for having no plan writes one blocked audit row", async (t) => {
  const session = await enforcingSession(t);
  const row = await blockedRow(
    session,
    { tool_name: "Bash", tool_input: { command: "ls" } },
    "intent_plan_missing"
  );
  assert.equal(row.session_id, session.sessionId);
  assert.equal(row.plan_id, undefined);
  assert.equal(row.step_index, -1);
  assert.deepEqual(row.input, {
    command: "ls",
    armoriq_policy: { source: "builtin", rule_id: "intent_plan_missing" },
  });
});

test("a call that drifts from the registered plan writes a blocked row linked to it, with no step", async (t) => {
  const session = await enforcingSession(t, { withPlan: true });
  const row = await blockedRow(
    session,
    { tool_name: "Bash", tool_input: { command: "ls" } },
    "intent_drift"
  );
  assert.equal(row.plan_id, PLAN_ID);
  assert.equal(row.step_index, -1);
});

test("a planned call the policy forbids writes a blocked row on the step it matched", async (t) => {
  const session = await enforcingSession(t, { withPlan: true });
  const row = await blockedRow(
    session,
    { tool_name: "Glob", tool_input: { pattern: "*" } },
    "policy_denied"
  );
  assert.equal(row.plan_id, PLAN_ID);
  assert.equal(row.step_index, 1);
});

test("the shared decision codes and UUID vectors are honored", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/block-capture-v1.json", import.meta.url))
  );
  const { decisionCode } = await import("../scripts/lib/decision-codes.mjs");
  const { createAuditEnvelope, snapshotAuditContext } =
    await import("../scripts/lib/audit-capture.mjs");
  for (const reason of fixture.reasonCodes) {
    for (const producer of reason.producers.armorclaude)
      assert.equal(decisionCode(producer), reason.decisionCode, producer);
  }
  assert.equal(decisionCode("unrecognized_stop"), "other");
  for (const vector of fixture.clientRowId.vectors) {
    const envelope = createAuditEnvelope({
      session_id: "child",
      parent_session_id: vector.rootSessionId,
      tool_use_id: vector.toolCallId,
    });
    assert.equal(
      envelope[vector.phase === "decision" ? "decisionId" : "resultId"],
      vector.clientRowId
    );
  }
  for (const [tokenPlanId, countedPlanId, expectedContext] of [
    ["same", "same", undefined],
    [null, "counted", "counted"],
    [null, null, undefined],
  ]) {
    const context = snapshotAuditContext(createAuditEnvelope(), { tokenPlanId, countedPlanId });
    assert.equal(context.plan_id, tokenPlanId || undefined);
    assert.equal(context.context_plan_id, expectedContext);
  }
});

for (const [code, decision, tool, args, effect] of [
  ["protected_policy_file", "protected_resource", "Write", null],
  [
    "policy_admin_command",
    "protected_resource",
    "Bash",
    { command: "node scripts/lib/armor-policy-commands.mjs" },
  ],
  ["missing_tool_name", "internal_error", "", {}],
  ["policy_denied", "policy_deny", "Glob", { pattern: "*" }, "forbid"],
  [
    "policy_requires_approval",
    "approval_required",
    "WebFetch",
    { url: "https://example.com" },
    "require_approval",
  ],
  ["mcp_server_unapproved", "approval_required", "mcp__github__get_issue", { number: 1 }],
  ["mcp_server_denied", "policy_deny", "mcp__github__get_issue", { number: 1 }, "mcp-deny"],
  ["intent_plan_missing", "missing_plan", "Bash", { command: "ls" }, "no-plan"],
  ["intent_drift", "out_of_scope", "Bash", { command: "ls" }, "drift"],
]) {
  test(`capture contract: ${code} writes one row with the decision context`, async (t) => {
    const s = await captureSession(t);
    if (
      effect === "forbid" ||
      effect === "require_approval" ||
      effect === "no-plan" ||
      effect === "drift"
    ) {
      await savePolicyState(s.config.policyFile, {
        version: 1,
        policy: {
          schemaVersion: "armor.policy.v1",
          kind: "PolicyProfile",
          metadata: { name: "capture" },
          defaults: { decision: "allow", conflictResolution: "deny_overrides" },
          statements: [
            statement(
              "stop",
              effect === "no-plan" || effect === "drift" ? "forbid" : effect,
              effect === "no-plan" || effect === "drift" ? "Write" : tool
            ),
          ],
        },
      });
    }
    if (effect === "mcp-deny") {
      await writeFile(
        s.config.runtimeFile,
        JSON.stringify({
          sessions: { "session-1": s.state },
          mcpRegistry: { github: { status: "denied" } },
        })
      );
    }
    if (effect === "no-plan" || effect === "drift") {
      s.config.intentRequired = true;
      if (effect === "no-plan") delete s.state.plan;
      // A plan bound to a prompt is enforced against a token; the local drift check runs for a plan registered without one (402 fallback).
      if (effect === "drift")
        s.state.unregisteredLocalPlan = {
          plan: s.state.plan,
          reason: "billing",
          message: "payment required",
        };
      await s.save();
    }
    const call = {
      session_id: "session-1",
      tool_use_id: "tool-call-1",
      tool_name: tool,
      tool_input: args ?? { file_path: s.config.policyFile, content: "secret" },
    };
    const output = await handlePreToolUse(call, s.config);
    assert.equal(
      output?.hookSpecificOutput?.permissionDecision,
      decision === "approval_required" ? "ask" : "deny"
    );
    const [row, ...extra] = await s.rows();
    assert.ok(row, code);
    assert.deepEqual(extra, []);
    assert.equal(row.client_row_id, "176f57b7-4cd2-54e6-88f1-369f22f5ab91");
    assert.equal(row.decision_code, decision);
    assert.equal(row.error_message, code);
    assert.equal(row.status, decision === "approval_required" ? "held" : "blocked");
    assert.equal(row.plan_id, s.state.tokenPlanId);
    assert.equal(row.context_plan_id, s.state.countedPlanId);
    assert.equal(row.prompt_id, "prompt-original");
  });
}

test("decision and result rows keep separate identities and snapshot before audit work", async (t) => {
  const s = await captureSession(t);
  const { createAuditEnvelope, snapshotAuditContext } =
    await import("../scripts/lib/audit-capture.mjs");
  const input = {
    session_id: "session-1",
    tool_use_id: "tool-call-1",
    tool_name: "Read",
    tool_input: { file_path: "/workspace/a" },
  };
  const envelope = snapshotAuditContext(createAuditEnvelope(input), s.state);
  input.armorAudit = envelope;
  s.state.promptId = "prompt-later";
  s.state.countedPlanId = randomUUID();
  s.state.tokenPlanId = randomUUID();
  assert.equal(envelope.prompt_id, "prompt-original");
  assert.equal(envelope.plan_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(envelope.context_plan_id, "11111111-1111-4111-8111-111111111111");
  s.state.intentTokenRaw = JSON.stringify({ planId: s.state.tokenPlanId });
  await s.save();
  await handlePostToolUse(input, s.config);
  await handlePostToolUseFailure({ ...input, error: "tool failed" }, s.config);
  const rows = await s.rows();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.client_row_id === "9bfbba71-1197-5d58-b7f3-7265ea21ea3c"));
  assert.ok(rows.every((row) => row.prompt_id === "prompt-original"));
  assert.ok(rows.every((row) => row.plan_id === "22222222-2222-4222-8222-222222222222"));
});

test("daemon fallback carries the allocated identity and captures one stop", async (t) => {
  const s = await captureSession(t);
  const { dispatchHook } = await import("../scripts/hook-router.mjs");
  let envelope;
  s.config.daemonEnabled = true;
  const output = await dispatchHook(
    "PreToolUse",
    { session_id: "session-1" },
    s.config,
    async ({ input }) => {
      envelope = structuredClone(input.armorAudit);
      s.state.promptId = "prompt-after-timeout";
      s.state.tokenPlanId = randomUUID();
      s.state.countedPlanId = randomUUID();
      await s.save();
      throw new Error("daemon unavailable");
    }
  );
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  const rows = await s.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_row_id, envelope.decisionId);
  assert.equal(rows[0].decision_code, "internal_error");
  assert.equal(rows[0].prompt_id, envelope.prompt_id);
  assert.equal(rows[0].plan_id, envelope.plan_id);
  assert.equal(rows[0].context_plan_id, envelope.context_plan_id);
});

for (const code of [
  "backend_unreachable",
  "crypto_policy_mismatch",
  "intent_token_blocked",
  "intent_token_expired",
  "plan_check_denied",
  "csrg_proof_invalid",
  "csrg_proof_rejected",
  "remote_verify_denied",
  "remote_verify_failed",
]) {
  test(`capture contract: ${code} records the exact producer code`, async (t) => {
    const s = await captureSession(t);
    const policy = {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "capture" },
      defaults: { decision: "allow", conflictResolution: "deny_overrides" },
      statements: [statement("no-glob", "forbid", "Glob")],
    };
    await savePolicyState(s.config.policyFile, { version: 1, policy });
    s.state.plan = { goal: "run shell", steps: [{ action: "Bash" }] };
    const token = {
      planId: s.state.tokenPlanId,
      jwtToken: "jwt-test",
      rawToken: { token: { signature: "test" }, plan: s.state.plan },
    };
    if (code === "intent_token_blocked") token.rawToken.plan = PLAN;
    if (code === "plan_check_denied") token.planCheck = { deniedTools: ["Bash"] };
    s.state.intentTokenRaw = JSON.stringify(token);
    s.state.intentPolicyCompilerVersion = "sdk-csrg-policy-v1";
    s.state.policyHash = computePolicyHash(policy);
    if (code === "intent_token_expired") s.state.expiresAt = Date.now() / 1000 - 1;
    if (code === "backend_unreachable") noteBackendUnreachable(s.config);
    if (code === "crypto_policy_mismatch") {
      s.config.cryptoPolicyEnabled = true;
      await writeFile(
        path.join(s.config.dataDir, "crypto-policy-state.json"),
        JSON.stringify({ policyDigest: "different-digest" })
      );
    }
    if (code === "csrg_proof_rejected") {
      s.config.requireCsrgProofs = true;
      s.config.csrgVerifyEnabled = true;
    }
    if (code.startsWith("remote_verify")) {
      s.config.csrgVerifyEnabled = true;
      t.mock.method(globalThis, "fetch", async (url) => {
        if (String(url).endsWith("/iap/verify-step")) {
          if (code === "remote_verify_failed") throw new Error("verification failed");
          return new Response(JSON.stringify({ allowed: false, reason: "denied" }));
        }
        return new Response(JSON.stringify({ orgId: "org-test", agents: [] }));
      });
    }
    await s.save();
    const output = await handlePreToolUse(
      {
        session_id: "session-1",
        tool_use_id: "tool-call-1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        ...(code === "csrg_proof_invalid" ? { csrg_proof: "{invalid" } : {}),
      },
      s.config
    );
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
    const [row, ...extra] = await s.rows();
    assert.deepEqual(extra, []);
    assert.equal(row.error_message, code);
    assert.equal(row.status, "blocked");
  });
}

test("fallback without login identity is counted locally and signed out stops send nothing", async (t) => {
  const s = await captureSession(t);
  const { captureFallback } = await import("../scripts/lib/audit-capture.mjs");
  const requests = [];
  t.mock.method(globalThis, "fetch", async (...args) => {
    requests.push(args[0]);
    return new Response("{}");
  });
  await captureFallback(
    {},
    { ...s.config, apiKey: "ak_test_localmock000000000000", userId: "" },
    "internal_error"
  );
  const failures = (
    await readFile(path.join(s.config.dataDir, "audit-capture-failures.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "internal_error");
  await captureFallback({}, { ...s.config, signedOut: true, apiKey: "" }, "invalid_payload");
  await captureFallback(
    {},
    { ...s.config, unconfigured: true, apiKey: "", auditEnabled: false },
    "invalid_payload"
  );
  assert.equal(
    (await readFile(path.join(s.config.dataDir, "audit-capture-failures.jsonl"), "utf8"))
      .trim()
      .split("\n").length,
    1
  );
  await handlePreToolUse(
    { session_id: "session-1", tool_name: "Write", tool_input: { file_path: s.config.policyFile } },
    { ...s.config, apiKey: "", auditEnabled: false }
  );
  assert.deepEqual(await s.rows(), []);
  assert.deepEqual(requests, []);
});

for (const raw of [
  "{invalid",
  "null",
  ...["PreToolUse", "PostToolUse", "PostToolUseFailure", "SessionStart", "Stop"].map(
    (hook_event_name) => JSON.stringify({ hook_event_name, session_id: "session-1" })
  ),
]) {
  // regression: #0010
  test(`router fallback handles ${raw}`, async (t) => {
    const s = await captureSession(t);
    const { writeLoginProfiles, tempHome } = await import("./helpers/login-profile.mjs");
    const home = writeLoginProfiles(tempHome(), [
      { backend: s.config.backendEndpoint, apiKey: s.config.apiKey },
    ]);
    const event = raw.startsWith('{"') ? JSON.parse(raw).hook_event_name : null;
    const stop = !event || event === "PreToolUse";
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/hook-router.mjs"], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_PLUGIN_DATA: s.config.dataDir,
          ARMORIQ_ENV: "local",
          ARMORIQ_ORG_MODE: "enforce",
          ARMORIQ_BACKEND_URL: s.config.backendEndpoint,
          ...(event ? { ARMORCLAUDE_RUNTIME_FILE: s.config.dataDir } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("error", reject);
      child.on("exit", (code) => {
        try {
          assert.equal(code, 0);
          if (stop) assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, "deny");
          else
            assert.match(
              JSON.parse(stdout).systemMessage,
              new RegExp(`^ArmorClaude internal error in ${event}: `)
            );
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(raw);
    });
    const rows = await s.rows();
    if (!stop) {
      assert.deepEqual(rows, []);
      const failures = (
        await readFile(path.join(s.config.dataDir, "audit-capture-failures.jsonl"), "utf8")
      )
        .trim()
        .split("\n");
      assert.equal(failures.length, 1);
      return;
    }
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tool, "unknown");
    assert.equal(rows[0].action, "unknown");
    assert.deepEqual(rows[0].input, {});
    assert.equal(rows[0].decision_code, "internal_error");
    assert.deepEqual(
      Object.keys(rows[0])
        .filter((key) => key !== "_enqueuedAt")
        .sort(),
      [
        "action",
        "client_row_id",
        "decision_code",
        "executed_at",
        "input",
        ...(event ? ["session_id"] : []),
        "status",
        "tool",
      ]
    );
  });
}

for (const handler of [handlePostToolUse, handlePostToolUseFailure]) {
  // regression: #0010
  test(`${handler.name} records a capture failure without throwing or creating a stop`, async (t) => {
    const s = await captureSession(t);
    s.state.intentTokenRaw = JSON.stringify({ planId: s.state.tokenPlanId });
    await s.save();
    await mkdir(path.join(s.config.dataDir, "audit"));
    await writeFile(
      path.join(
        s.config.dataDir,
        "audit",
        (await import("../scripts/lib/audit-wal.mjs")).loginTag(
          s.config.backendEndpoint,
          s.config.apiKey
        )
      ),
      "storage is unavailable"
    );
    assert.equal(
      await handler({ session_id: "session-1", tool_name: "Read", tool_input: {} }, s.config),
      null
    );
    const failures = (
      await readFile(path.join(s.config.dataDir, "audit-capture-failures.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "internal_error");
  });
}

// regression: #0010
test("an expired token's stop records the refreshed plan and the original prompt", async (t) => {
  const s = await captureSession(t);
  const refreshedId = randomUUID();
  const policyState = await loadPolicyState(s.config.policyFile);
  policyState.policy.statements.push(statement("hold-fetch", "require_approval", "WebFetch"));
  await savePolicyState(s.config.policyFile, policyState);
  const token = {
    planId: s.state.tokenPlanId,
    jwtToken: "jwt-test",
    rawToken: { plan: s.state.plan },
  };
  Object.assign(s.state, {
    intentTokenRaw: JSON.stringify(token),
    tokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: Date.now() / 1000 - 1,
    promptOpenSince: Date.now(),
    lastActivityAt: Date.now(),
    promptGeneration: 1,
    authGeneration: 0,
    policyHash: computePolicyHash(policyState.policy),
    intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
  });
  await s.save();
  t.mock.method(armoriqSdk.ArmorIQClient.prototype, "getIntentToken", async () => ({
    ...token,
    planId: refreshedId,
    kind: "refresh",
    expiresAt: Date.now() / 1000 + 180,
  }));
  const output = await handlePreToolUse(
    { session_id: "session-1", tool_name: "Bash", tool_input: { command: "ls" } },
    { ...s.config, intentRequired: true }
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  const [row] = await s.rows();
  assert.equal(row.plan_id, refreshedId);
  assert.equal(row.context_plan_id, s.state.countedPlanId);
  assert.equal(row.prompt_id, "prompt-original");
});
