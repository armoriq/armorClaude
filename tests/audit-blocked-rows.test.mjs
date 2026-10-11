import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { savePolicyState } from "../scripts/lib/policy.mjs";
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
  assert.deepEqual(row.input, { command: "ls" });
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
