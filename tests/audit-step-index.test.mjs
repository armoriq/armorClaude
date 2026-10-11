import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";

const PLAN_ID = randomUUID();
const PLAN = {
  goal: "inspect the repo",
  steps: [
    { action: "Bash", mcp: "claude-code", metadata: { inputs: { command: "ls" } } },
    { action: "Bash", mcp: "claude-code" },
    { action: "Skill", mcp: "claude-code" },
  ],
};

async function plannedSession(t) {
  const backend = await startBackend();
  const session = await startHookSession(t, backend);
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
    path.join(session.dataDir, "runtime.json"),
    JSON.stringify({
      sessions: { [session.sessionId]: { intentTokenRaw: JSON.stringify(token), plan: PLAN } },
    })
  );
  return { ...session, backend };
}

async function stepsFor(t, calls) {
  const { backend, hook } = await plannedSession(t);
  for (const [tool_name, tool_input, event = "PostToolUse"] of calls) {
    await hook({ hook_event_name: event, tool_name, tool_input, tool_response: { ok: true } });
  }
  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.auditRows.length === calls.length, 15_000, "every audit row");
  return backend.auditRows.map((row) => row.step_index);
}

test("a repeated tool is recorded against the next plan step it matches, not the first", async (t) => {
  const steps = await stepsFor(t, [
    ["Bash", { command: "ls" }],
    ["Skill", { skill: "review" }],
    ["Bash", { command: "ls" }],
  ]);
  assert.deepEqual(steps, [0, 2, 1]);
});

test("a call with other parameters takes the unconstrained step even after it repeats", async (t) => {
  const steps = await stepsFor(t, [
    ["Bash", { command: "ls" }],
    ["Bash", { command: "pwd" }],
    ["Skill", { skill: "review" }],
  ]);
  assert.deepEqual(steps, [0, 1, 2]);
});

test("a failed call does not use up its step, so the retry lands on the same step", async (t) => {
  const steps = await stepsFor(t, [
    ["Bash", { command: "ls" }, "PostToolUseFailure"],
    ["Bash", { command: "ls" }],
    ["Bash", { command: "ls" }],
  ]);
  assert.deepEqual(steps, [0, 0, 1]);
});

test("once every matching step is used, a further call falls back to the first match", async (t) => {
  const steps = await stepsFor(t, [
    ["Skill", { skill: "a" }],
    ["Skill", { skill: "b" }],
  ]);
  assert.deepEqual(steps, [2, 2]);
});
