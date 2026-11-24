import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computePolicyHash, loadPolicyState, savePolicyState } from "../scripts/lib/policy.mjs";
import {
  mockTokenBackend,
  startBackend,
  startHookSession,
  waitFor,
} from "./helpers/hook-session.mjs";
import { handlePreToolUse, handleUserPromptSubmit } from "../scripts/lib/engine.mjs";
import { registerIntentPlan } from "../scripts/lib/intent.mjs";
import { normalizeIntentPlan } from "../scripts/lib/intent-schema.mjs";
import { recordHookActivity, updateRuntimeState } from "../scripts/lib/runtime-state.mjs";
import { loadConfigWithLogins } from "./helpers/login-profile.mjs";

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

// regression: #101
test("billing refusals keep local plan and policy enforcement without registration loops", async (t) => {
  for (const message of [
    "An active ArmorIQ Pro subscription is required to use armorclaude.",
    "This API key has no organization, so billing cannot be verified.",
  ]) {
    await t.test(message, async (t) => {
      const dataDir = await mkdtemp(path.join(os.tmpdir(), "aq-billing-"));
      t.after(() => rm(dataDir, { recursive: true, force: true }));
      const config = {
        ...loadConfigWithLogins([], { CLAUDE_PLUGIN_DATA: dataDir }),
        apiKey: "ak_test_billing",
        mode: "enforce",
        intentRequired: true,
        signedOut: false,
        backendEndpoint: "http://127.0.0.1:1",
        csrgEndpoint: "http://127.0.0.1:1",
        auditEnabled: false,
        csrgVerifyEnabled: false,
        cryptoPolicyEnabled: false,
      };
      let billing = true;
      const requests = mockTokenBackend(t, () =>
        billing
          ? [402, { error: "payment_required", message }]
          : [
              200,
              {
                success: true,
                plan_id: randomUUID(),
                kind: "new",
                intent_reference: "billing-resumed",
                plan_hash: "signed-plan-hash",
                token: { issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
                step_proofs: [],
              },
            ]
      );
      t.mock.method(globalThis, "fetch", async () =>
        Response.json({ orgId: "org-test", agents: [] })
      );
      const sessionId = randomUUID();
      const policyFile = config.policyFile;
      const state = await loadPolicyState(policyFile);
      state.policy.statements.push(
        ...[
          ["deny-edit", "deny", "Edit"],
          ["hold-web", "require_approval", "WebFetch"],
        ].map(([id, effect, tool]) => ({
          id,
          effect,
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", eq: tool },
          resource: { type: "workspace", scope: "current" },
          conditions: [],
        }))
      );
      await savePolicyState(policyFile, state);
      await handleUserPromptSubmit({ session_id: sessionId, prompt: "write notes" }, config);
      await recordHookActivity({ session_id: sessionId }, config, process.ppid);
      const result = await registerIntentPlan(
        config,
        normalizeIntentPlan({
          goal: "write notes",
          steps: [{ action: "Write" }, { action: "Edit" }, { action: "WebFetch" }],
        })
      );
      assert.match(result.content[0].text, /Plan recorded locally, not registered \(billing\)/);
      assert.doesNotMatch(result.content[0].text, /Intent registered/);
      assert.match(result.content[0].text, /https:\/\/tools.armoriq.ai\/tools\/billing/);
      const call = (tool_name) =>
        handlePreToolUse({ session_id: sessionId, tool_name, tool_input: {} }, config);
      const allowed = await call("Write");
      assert.equal(denied(allowed), false, JSON.stringify(allowed));
      assert.match(allowed.systemMessage, /locally.*Upgrade:/);
      assert.equal((await call("Write"))?.systemMessage, undefined);
      assert.equal(denied(await call("Edit")), true);
      assert.equal((await call("WebFetch"))?.hookSpecificOutput?.permissionDecision, "ask");
      assert.equal(denied(await call("Bash")), true);
      assert.equal(requests.length, 1);
      if (message.startsWith("An active")) {
        billing = false;
        const registered = await registerIntentPlan(
          config,
          normalizeIntentPlan({
            goal: "write notes",
            steps: [{ action: "Write" }],
          })
        );
        assert.notEqual(registered.isError, true, registered.content[0].text);
        await updateRuntimeState(config.runtimeFile, (runtime) => {
          runtime.sessions[sessionId].expiresAt = Date.now() / 1000 - 1;
          runtime.sessions[sessionId].tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
        });
        billing = true;
        assert.equal(denied(await call("Write")), false);
        assert.equal(requests.length, 3);
      }
    });
  }
});

// regression: #0007
test("with no confirmed policy, tools run without a plan or token request and audit rows have no plan", async (t) => {
  const backend = await startBackend(tokenRoute(randomUUID()));
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
  assert.equal(tokenRequests.length, 0);
  await hook({ hook_event_name: "PostToolUse", ...list, tool_response: { stdout: "a\n" } });

  const offPlan = { tool_name: "Write", tool_input: { file_path: "notes.txt", content: "hi" } };
  assert.equal(denied(await hook({ hook_event_name: "PreToolUse", ...offPlan })), false);
  await hook({ hook_event_name: "PostToolUse", ...offPlan, tool_response: { ok: true } });

  await waitFor(() => backend.auditRows.length === 2, 15_000, "two audit rows at the backend");
  assert.deepEqual(
    backend.auditRows.map((r) => [r.tool, r.plan_id ?? null]),
    [
      ["Bash", null],
      ["Write", null],
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

// regression: #0007
test("tools run under allow all but need registration once an enforcing policy is confirmed", async (t) => {
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

// regression: #0007
test("under allow all repeated tools and new prompts never request a token", async (t) => {
  const backend = await startBackend({
    "POST /iap/sdk/token": () => [402, { message: "Payment required: upgrade to Pro" }],
  });
  const { hook } = await startHookSession(t, backend);
  const tokenRequests = () => backend.requests.filter((r) => r.route === "POST /iap/sdk/token");
  const bash = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };

  await hook({ hook_event_name: "UserPromptSubmit", prompt: "list the files" });
  assert.equal(denied(await hook(bash)), false);
  const afterFirst = tokenRequests().length;
  assert.equal(afterFirst, 0);
  for (let i = 0; i < 2; i++) assert.equal(denied(await hook(bash)), false);
  assert.equal(tokenRequests().length, afterFirst);

  await hook({ hook_event_name: "UserPromptSubmit", prompt: "list them again" });
  assert.equal(denied(await hook(bash)), false);
  assert.equal(tokenRequests().length, 0);
});

// regression: #0007
test("ExitPlanMode does not register a plan from the approved plan file", async (t) => {
  const backend = await startBackend(tokenRoute(randomUUID()));
  const { env, dataDir, sessionId, hook } = await startHookSession(t, backend);
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "write notes" });
  const planFilePath = path.join(env.HOME, ".claude", "plans", `${sessionId}.md`);
  await mkdir(path.dirname(planFilePath), { recursive: true });
  await writeFile(
    planFilePath,
    '# Plan\n```json\n{"goal":"write notes","steps":[{"action":"Write"}]}\n```\n'
  );
  const output = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "ExitPlanMode",
    transcript_path: `sessions/${sessionId}.jsonl`,
    tool_input: {},
  });
  assert.equal(denied(output), false);
  assert.equal(backend.requests.filter((r) => r.route === "POST /iap/sdk/token").length, 0);
  const session = JSON.parse(await readFile(path.join(dataDir, "runtime.json"), "utf8")).sessions[
    sessionId
  ];
  assert.equal(session.countedPlanId, null);
  assert.equal(session.plan, undefined);
});
