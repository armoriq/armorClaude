import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { computePolicyHash, savePolicyState } from "../scripts/lib/policy.mjs";
import { startBackend, startHookSession } from "./helpers/hook-session.mjs";

const POLICY = {
  schemaVersion: "armor.policy.v1",
  kind: "PolicyProfile",
  metadata: { name: "enforcing", description: "" },
  defaults: { decision: "allow", conflictResolution: "deny_overrides" },
  statements: [
    {
      id: "hold-webfetch",
      effect: "require_approval",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "WebFetch" },
      resource: { type: "workspace", scope: "current" },
      conditions: [],
    },
  ],
};
const ALLOW_ALL = {
  ...POLICY,
  metadata: { name: "allow-all", description: "" },
  statements: [],
};
const PLAN = {
  goal: "edit the repo",
  steps: [
    { action: "Bash", mcp: "claude-code" },
    { action: "Edit", mcp: "claude-code" },
  ],
};

async function plannedSession(t, { planCheck, policy = POLICY, env }) {
  const backend = await startBackend();
  const session = await startHookSession(t, backend, env);
  await savePolicyState(path.join(session.dataDir, "policy.json"), { version: 1, policy });
  const planId = randomUUID();
  const token = {
    tokenId: "intent-ref",
    planHash: "plan-hash",
    planId,
    signature: "sig",
    issuedAt: 1,
    expiresAt: 4_102_444_800,
    policy: {},
    compositeIdentity: "",
    stepProofs: [],
    totalSteps: PLAN.steps.length,
    rawToken: { plan: PLAN, plan_id: planId, token: {}, plan_hash: "plan-hash" },
    planCheck,
  };
  const state = {
    intentTokenRaw: JSON.stringify(token),
    plan: PLAN,
    expiresAt: 4_102_444_800,
    policyHash: computePolicyHash(policy),
    intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
  };
  await writeFile(
    path.join(session.dataDir, "runtime.json"),
    JSON.stringify({ sessions: { [session.sessionId]: state } })
  );
  const pre = (tool_name, tool_input) =>
    session.hook({ hook_event_name: "PreToolUse", tool_name, tool_input });
  return { ...session, pre };
}

const check = (validated, deniedTools, deniedReasons, reason) => ({
  validated,
  ...(reason ? { reason } : {}),
  allowedTools: [],
  deniedTools,
  deniedReasons,
  defaultEnforcementAction: "block",
});
const reasonOf = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? "";
const denied = (output) => output?.hookSpecificOutput?.permissionDecision === "deny";

test("in enforce mode a tool the plan check denies is denied with the backend's reason", async (t) => {
  const { pre } = await plannedSession(t, {
    planCheck: check(true, ["Bash"], ["Bash: block:forbid-shell#0"]),
  });
  const output = await pre("Bash", { command: "ls" });
  assert.equal(denied(output), true, JSON.stringify(output));
  assert.match(reasonOf(output), /plan check denied Bash/);
  assert.match(reasonOf(output), /Bash: block:forbid-shell#0/);
  assert.doesNotMatch(reasonOf(await pre("Edit", { file_path: "a.txt" })), /plan check denied/);
});

test("a plan check that did not validate still denies the tools it lists", async (t) => {
  const { pre } = await plannedSession(t, {
    planCheck: check(
      false,
      ["Bash", "Edit"],
      ["Bash: no_active_policy", "Edit: no_active_policy"],
      "no_active_policy"
    ),
  });
  const output = await pre("Edit", { file_path: "a.txt" });
  assert.equal(denied(output), true, JSON.stringify(output));
  assert.match(reasonOf(output), /plan check denied Edit \(Edit: no_active_policy\)/);
});

test("under the All Allow template the plan check's denials do not block", async (t) => {
  const { pre } = await plannedSession(t, {
    policy: ALLOW_ALL,
    planCheck: check(true, ["Bash"], ["Bash: block:forbid-shell#0"]),
  });
  assert.doesNotMatch(reasonOf(await pre("Bash", { command: "ls" })), /plan check denied/);
});

test("in monitor mode a denied tool runs and the would-be denial is logged", async (t) => {
  const { pre, dataDir } = await plannedSession(t, {
    env: { ARMORIQ_ENV: "staging" },
    planCheck: check(true, ["Bash"], ["Bash: block:forbid-shell#0"]),
  });
  const output = await pre("Bash", { command: "ls" });
  assert.equal(denied(output), false, JSON.stringify(output));
  const log = readFileSync(path.join(dataDir, "daemon.log"), "utf8");
  assert.match(log, /monitor: ArmorIQ plan check denied Bash \(Bash: block:forbid-shell#0\)/);
});

async function registeredSession(t, { planCheck, policy = POLICY, env }) {
  const backend = await startBackend();
  const session = await startHookSession(t, backend, env);
  await savePolicyState(path.join(session.dataDir, "policy.json"), { version: 1, policy });
  const plan = {
    goal: "read the docs",
    steps: [
      { action: "Read", mcp: "claude-code" },
      { action: "WebFetch", mcp: "claude-code" },
      { action: "Edit", mcp: "claude-code" },
    ],
  };
  const planId = randomUUID();
  const token = {
    tokenId: "intent-ref",
    planHash: "plan-hash",
    planId,
    signature: "sig",
    issuedAt: 1,
    expiresAt: 4_102_444_800,
    policy: {},
    compositeIdentity: "",
    stepProofs: [],
    totalSteps: plan.steps.length,
    rawToken: { plan, plan_id: planId, token: {}, plan_hash: "plan-hash" },
    planCheck,
  };
  await writeFile(
    path.join(session.dataDir, `pending-plan.${session.sessionId}.json`),
    JSON.stringify({
      sessionId: session.sessionId,
      plan,
      tokenRaw: JSON.stringify(token),
      allowedActions: ["read", "webfetch", "edit"],
      expiresAt: 4_102_444_800,
      policyHash: computePolicyHash(policy),
      intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
      registeredAt: Date.now(),
    })
  );
  const pre = (tool_name, tool_input) =>
    session.hook({ hook_event_name: "PreToolUse", tool_name, tool_input });
  return { ...session, pre };
}

const READ_DENIED = check(
  true,
  ["Read", "WebFetch"],
  ["Read: block:no-reads#0", "WebFetch: block:no-fetch#0"]
);

test("in enforce mode a Read or WebFetch the plan check denies is denied, before and after the plan is consumed (#394)", async (t) => {
  const { pre } = await registeredSession(t, { planCheck: READ_DENIED });
  const first = await pre("Read", { file_path: "/tmp/a.txt" });
  assert.equal(denied(first), true, JSON.stringify(first));
  assert.match(reasonOf(first), /plan check denied Read \(Read: block:no-reads#0\)/);
  const fetch = await pre("WebFetch", { url: "https://example.com", prompt: "x" });
  assert.equal(denied(fetch), true, JSON.stringify(fetch));
  assert.match(reasonOf(fetch), /plan check denied WebFetch/);
  await pre("Edit", { file_path: "/tmp/a.txt", old_string: "a", new_string: "b" });
  const later = await pre("Read", { file_path: "/tmp/a.txt" });
  assert.equal(denied(later), true, JSON.stringify(later));
  assert.match(reasonOf(later), /plan check denied Read/);
  assert.equal(denied(await pre("Glob", { pattern: "*" })), false);
});

test("a read-only tool the plan check does not name still runs (#394)", async (t) => {
  const { pre } = await registeredSession(t, {
    planCheck: check(true, ["Bash"], ["Bash: block:forbid-shell#0"]),
  });
  assert.equal(denied(await pre("Read", { file_path: "/tmp/a.txt" })), false);
  await pre("Edit", { file_path: "/tmp/a.txt", old_string: "a", new_string: "b" });
  assert.equal(denied(await pre("Read", { file_path: "/tmp/a.txt" })), false);
});

test("under the All Allow template the plan check does not block read-only tools (#394)", async (t) => {
  const { pre } = await registeredSession(t, { policy: ALLOW_ALL, planCheck: READ_DENIED });
  assert.doesNotMatch(reasonOf(await pre("Read", { file_path: "/tmp/a.txt" })), /plan check/);
});

test("in monitor mode a Read the plan check denies runs and the would-be denial is logged (#394)", async (t) => {
  const { pre, dataDir } = await registeredSession(t, {
    env: { ARMORIQ_ENV: "staging" },
    planCheck: READ_DENIED,
  });
  const output = await pre("Read", { file_path: "/tmp/a.txt" });
  assert.equal(denied(output), false, JSON.stringify(output));
  const log = readFileSync(path.join(dataDir, "daemon.log"), "utf8");
  assert.match(log, /monitor: ArmorIQ plan check denied Read \(Read: block:no-reads#0\)/);
});
