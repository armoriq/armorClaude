import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { computePolicyHash, loadPolicyState, savePolicyState } from "../scripts/lib/policy.mjs";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";

function tokenRoute(planId) {
  return {
    "POST /iap/sdk/token": () => [
      200,
      {
        success: true,
        plan_id: planId,
        plan_hash: "plan-hash",
        intent_reference: "intent-ref",
        token: { issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
        step_proofs: [],
      },
    ],
  };
}

const denied = (output) => output?.hookSpecificOutput?.permissionDecision === "deny";

test("with no confirmed policy, intent is captured: directive, plan, token and plan-linked audit rows, nothing denied (#294)", async (t) => {
  const planId = randomUUID();
  const backend = await startBackend(tokenRoute(planId));
  const { dataDir, hook } = await startHookSession(t, backend);
  assert.equal(existsSync(path.join(dataDir, "policy.json")), false);

  const start = await hook({ hook_event_name: "SessionStart", source: "startup" });
  assert.match(start.hookSpecificOutput.additionalContext, /intent=capture/);

  const prompt = await hook({ hook_event_name: "UserPromptSubmit", prompt: "list the files" });
  const directive = prompt?.hookSpecificOutput?.additionalContext ?? "";
  assert.match(directive, /ArmorClaude intent capture is active/);
  assert.match(directive, /register_intent_plan/);

  const list = { tool_name: "Bash", tool_input: { command: "ls" } };
  assert.equal(denied(await hook({ hook_event_name: "PreToolUse", ...list })), false);
  const tokenRequests = backend.requests.filter((r) => r.route === "POST /iap/sdk/token");
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].body.plan.steps[0].action, "Bash");
  await hook({ hook_event_name: "PostToolUse", ...list, tool_response: { stdout: "a\n" } });

  const offPlan = { tool_name: "Write", tool_input: { file_path: "notes.txt", content: "hi" } };
  assert.equal(denied(await hook({ hook_event_name: "PreToolUse", ...offPlan })), false);
  await hook({ hook_event_name: "PostToolUse", ...offPlan, tool_response: { ok: true } });

  await waitFor(() => backend.auditRows.length === 2, 15_000, "two audit rows at the backend");
  assert.deepEqual(
    backend.auditRows.map((r) => [r.tool, r.plan_id]),
    [
      ["Bash", planId],
      ["Write", planId],
    ]
  );
});

test("under an all-allow policy an expired intent token that cannot be refreshed does not block the tool (#294)", async (t) => {
  const backend = await startBackend({ "POST /iap/sdk/token": () => [500, { message: "down" }] });
  const { dataDir, sessionId, hook } = await startHookSession(t, backend);
  const plan = { goal: "list", steps: [{ action: "Bash", mcp: "claude-code" }] };
  const { policy } = await loadPolicyState(path.join(dataDir, "policy.json"));
  await writeFile(
    path.join(dataDir, "runtime.json"),
    JSON.stringify({
      sessions: {
        [sessionId]: {
          intentTokenRaw: JSON.stringify({ planId: randomUUID(), rawToken: { plan } }),
          plan,
          expiresAt: Math.floor(Date.now() / 1000) - 60,
          policyHash: computePolicyHash(policy),
          intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
        },
      },
    })
  );

  const output = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  assert.equal(denied(output), false, JSON.stringify(output));
});

test("a plan captured under allow-all does not count as registered once an enforcing policy is confirmed (#294)", async (t) => {
  const backend = await startBackend(tokenRoute(randomUUID()));
  const { dataDir, hook } = await startHookSession(t, backend);
  const bash = { tool_name: "Bash", tool_input: { command: "ls" } };

  await hook({ hook_event_name: "SessionStart", source: "startup" });
  assert.equal(denied(await hook({ hook_event_name: "PreToolUse", ...bash })), false);

  await savePolicyState(path.join(dataDir, "policy.json"), {
    version: 1,
    policy: {
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
    },
  });

  const output = await hook({ hook_event_name: "PreToolUse", ...bash });
  assert.equal(denied(output), true, JSON.stringify(output));
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /intent plan missing/);
});

test("under an all-allow policy a malformed CSRG proof header does not block the tool (#294)", async (t) => {
  const backend = await startBackend(tokenRoute(randomUUID()));
  const { hook } = await startHookSession(t, backend);
  const output = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    csrg_path: "/steps/[0]/action",
    csrg_proof: "{not-json}",
    csrg_value_digest: "abc",
  });
  assert.equal(denied(output), false, JSON.stringify(output));
});

test("under an all-allow policy a failed token request is not retried until the next prompt (#294)", async (t) => {
  const backend = await startBackend({
    "POST /iap/sdk/token": () => [402, { message: "Payment required: upgrade to Pro" }],
  });
  const { hook } = await startHookSession(t, backend);
  const tokenRequests = () => backend.requests.filter((r) => r.route === "POST /iap/sdk/token");
  const bash = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };

  await hook({ hook_event_name: "UserPromptSubmit", prompt: "list the files" });
  assert.equal(denied(await hook(bash)), false);
  const afterFirst = tokenRequests().length;
  assert.ok(afterFirst > 0);
  for (let i = 0; i < 2; i++) assert.equal(denied(await hook(bash)), false);
  assert.equal(tokenRequests().length, afterFirst);

  await hook({ hook_event_name: "UserPromptSubmit", prompt: "list them again" });
  assert.equal(denied(await hook(bash)), false);
  assert.ok(tokenRequests().length > afterFirst);
});
