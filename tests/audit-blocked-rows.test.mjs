import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { savePolicyState } from "../scripts/lib/policy.mjs";
import { handlePostToolUse, handlePostToolUseFailure } from "../scripts/lib/engine.mjs";
import { captureSession } from "./helpers/audit-capture.mjs";
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
