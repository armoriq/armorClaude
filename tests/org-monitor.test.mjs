import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { savePolicyState } from "../scripts/lib/policy.mjs";
import { markReloginRequired } from "../scripts/lib/relogin.mjs";
import {
  API_KEY,
  startBackend,
  startHookSession,
  startPolicyMcp,
  waitFor,
} from "./helpers/hook-session.mjs";

const statement = (id, effect, tool) => ({
  id,
  effect,
  principal: { type: "agent", id: "claude-code" },
  action: { type: "tool", eq: tool },
  resource: { type: "workspace", scope: "current" },
  conditions: [],
});

const POLICY = {
  schemaVersion: "armor.policy.v1",
  kind: "PolicyProfile",
  metadata: { name: "org-monitor", description: "" },
  defaults: { decision: "allow", conflictResolution: "deny_overrides" },
  statements: [
    statement("no-glob", "forbid", "Glob"),
    statement("hold-webfetch", "require_approval", "WebFetch"),
  ],
};

const PLAN_ID = "33333333-3333-4333-8333-333333333333";

const issued = (kind) => ({
  success: true,
  plan_id: PLAN_ID,
  kind,
  intent_reference: "intent-monitor",
  plan_hash: "plan-hash",
  token: { issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
  step_proofs: [],
});

const planDirective = (output) => {
  assert.deepEqual(Object.keys(output ?? {}), ["hookSpecificOutput"]);
  assert.match(
    output.hookSpecificOutput.additionalContext,
    /^ArmorClaude intent capture is active\..*register_intent_plan/s
  );
};

async function orgSession(t, active, routes = {}) {
  const backend = await startBackend({
    "GET /policies/profiles/active": () => [200, { version: 1, policy: null, ...active }],
    "POST /iap/sdk/token": (_, req) => [200, issued(req.headers["x-armoriq-plan-kind"])],
    ...routes,
  });
  const session = await startHookSession(t, backend, { ARMORIQ_ORG_MODE: "" });
  await savePolicyState(path.join(session.dataDir, "policy.json"), { version: 1, policy: POLICY });
  const start = await session.hook({ hook_event_name: "SessionStart" });
  return { ...session, backend, start };
}

for (const [label, active] of [
  ["says Monitor", { enforcementMode: "shadow" }],
  ["predates the setting", {}],
]) {
  test(`an org that ${label} registers a plan as Enforce does, runs every call and records what Enforce would have done`, async (t) => {
    const { hook, backend, start, env, sessionId } = await orgSession(t, active);
    assert.equal(start, null);
    planDirective(await hook({ hook_event_name: "UserPromptSubmit", prompt: "tidy the repo" }));
    const client = await startPolicyMcp(t, env, sessionId);
    const registered = await client.callTool({
      name: "register_intent_plan",
      arguments: {
        goal: "tidy the repo",
        steps: [{ action: "Glob" }, { action: "WebFetch" }, { action: "Read" }],
      },
    });
    assert.match(
      registered.content[0].text,
      new RegExp(`^Intent registered: plan ${PLAN_ID} \\(new\\)`)
    );
    const [sent] = backend.requests.filter((r) => r.route === "POST /iap/sdk/token");
    assert.equal(sent.headers["x-armoriq-plan-kind"], "new");
    assert.match(sent.headers["x-armoriq-prompt-id"], /^[0-9a-f-]{36}$/);
    assert.match(sent.headers["idempotency-key"], /^pcc1:[0-9a-f]{64}$/);

    const calls = [
      ["Glob", { pattern: "*" }, "block", "policy_denied"],
      ["WebFetch", { url: "https://example.com" }, "hold", "policy_requires_approval"],
      ["Read", { file_path: "/tmp/x" }, undefined, undefined],
    ];
    for (const [tool_name, tool_input] of calls) {
      const call = { tool_name, tool_input, tool_use_id: `use-${tool_name}` };
      assert.equal(await hook({ hook_event_name: "PreToolUse", ...call }), null, tool_name);
      await hook({ hook_event_name: "PostToolUse", ...call, tool_response: { ok: true } });
    }
    await hook({ hook_event_name: "Stop" });
    await waitFor(() => backend.auditRows.length === calls.length, 15_000, "one row per call");

    assert.deepEqual(
      backend.auditRows.map((r) => [r.tool, r.status, r.would_be, r.would_be_code, r.plan_id]),
      calls.map(([tool, , wouldBe, code]) => [tool, "success", wouldBe, code, PLAN_ID])
    );
    assert.deepEqual(
      [...new Set(backend.auditRows.map((r) => r.prompt_id))],
      [sent.headers["x-armoriq-prompt-id"]]
    );
    const asked = backend.requests.map((r) => r.route);
    assert.equal(asked.filter((r) => /\/iap\/sdk\/enforce|\/delegation/.test(r)).length, 0);
    const told = (route) =>
      backend.requests.filter((r) => r.route === route).map((r) => r.monitorAware);
    assert.deepEqual([...new Set(told("GET /policies/profiles/active"))], ["1"]);
    assert.deepEqual([...new Set(told("POST /iap/audit/batch"))], ["1"]);
  });
}

test("an org in Monitor with notes runs every call and tells the user what Enforce would have done", async (t) => {
  const { hook, backend, start } = await orgSession(t, {
    enforcementMode: "shadow",
    monitorNotices: true,
  });
  assert.equal(start, null);
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "tidy the repo" });

  const shown = {};
  for (const [tool_name, tool_input] of [
    ["Glob", { pattern: "*" }],
    ["WebFetch", { url: "https://example.com" }],
    ["Read", { file_path: "/tmp/x" }],
  ]) {
    const call = { tool_name, tool_input, tool_use_id: `use-${tool_name}` };
    shown[tool_name] = await hook({ hook_event_name: "PreToolUse", ...call });
    await hook({ hook_event_name: "PostToolUse", ...call, tool_response: { ok: true } });
  }
  assert.equal(shown.Read, null);
  assert.equal(shown.Glob.hookSpecificOutput.permissionDecision, undefined);
  assert.match(shown.Glob.systemMessage, /would block this call.*no-glob.*Monitor let it run/);
  assert.equal(shown.WebFetch.hookSpecificOutput.permissionDecision, undefined);
  assert.match(shown.WebFetch.systemMessage, /would ask for approval.*Monitor let it run/);

  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.auditRows.length === 3, 15_000, "one row per call");
  assert.deepEqual(
    backend.auditRows.map((r) => [r.tool, r.status, r.would_be]),
    [
      ["Glob", "success", "block"],
      ["WebFetch", "success", "hold"],
      ["Read", "success", undefined],
    ]
  );
});

test("an org in Monitor runs the call after its plan request fails and reports the failure", async (t) => {
  const events = [];
  const { hook, backend, env, sessionId } = await orgSession(
    t,
    { enforcementMode: "shadow" },
    {
      "POST /iap/sdk/token": () => [422, { error: "org_required", message: "org_required" }],
      "POST /iap/client-events": (body) => {
        events.push(...body.events);
        return [
          200,
          { results: body.events.map(({ event_id }) => ({ event_id, outcome: "accepted" })) },
        ];
      },
    }
  );
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "write notes" });
  const client = await startPolicyMcp(t, env, sessionId);
  const failed = await client.callTool({
    name: "register_intent_plan",
    arguments: { goal: "write notes", steps: [{ action: "Write" }] },
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, "Plan not registered: org_required.");
  const call = { tool_name: "Write", tool_input: { file_path: "/tmp/notes.txt", content: "x" } };
  assert.equal(await hook({ hook_event_name: "PreToolUse", ...call }), null);
  await hook({ hook_event_name: "Stop" });
  await backend.waitForRequest("POST /iap/client-events");
  assert.deepEqual(
    events.map((e) => [e.type, e.reason_code]),
    [["plan_request_failed", "rejected"]]
  );
});

test("an org that says Enforce blocks the call", async (t) => {
  const { hook } = await orgSession(t, { enforcementMode: "enforce" });
  const out = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Glob",
    tool_input: { pattern: "*" },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("an org in Monitor shows only the plan directive from the session start that learns it, and an Enforce org shows its sign-in line from the same point", async (t) => {
  const mode = { enforcementMode: "shadow" };
  const backend = await startBackend({
    "GET /policies/profiles/active": () => [200, { version: 1, policy: null, ...mode }],
  });
  const { hook, dataDir } = await startHookSession(t, backend, { ARMORIQ_ORG_MODE: "" });
  markReloginRequired({ dataDir, observabilityEndpoint: backend.url, apiKey: API_KEY });

  assert.equal(await hook({ hook_event_name: "SessionStart" }), null);
  planDirective(await hook({ hook_event_name: "UserPromptSubmit", prompt: "hi" }));

  mode.enforcementMode = "enforce";
  const start = await hook({ hook_event_name: "SessionStart" });
  assert.match(start?.systemMessage ?? "", /sign in again/);

  mode.enforcementMode = "shadow";
  assert.equal(await hook({ hook_event_name: "SessionStart" }), null);
});

test("an updated copy puts back the policy an older copy swapped for the Monitor stand-in", async (t) => {
  const standIn = {
    ...POLICY,
    metadata: { name: "armoriq-monitor-stand-in", description: "" },
    statements: [],
  };
  const backend = await startBackend({
    "GET /policies/profiles/active": () => [
      200,
      { version: 1, policy: null, enforcementMode: "shadow" },
    ],
    "POST /intent": () => [200, { token: "csrg-policy-token" }],
  });
  const { hook, dataDir } = await startHookSession(t, backend, { ARMORIQ_ORG_MODE: "" });
  await savePolicyState(path.join(dataDir, "policy.json"), {
    version: 2,
    policy: standIn,
    history: [
      { version: 1, policy: POLICY },
      { version: 2, policy: standIn },
    ],
  });
  await hook({ hook_event_name: "SessionStart" });
  const call = { tool_name: "Glob", tool_input: { pattern: "*" }, tool_use_id: "use-glob" };
  assert.equal(await hook({ hook_event_name: "PreToolUse", ...call }), null);
  await hook({ hook_event_name: "PostToolUse", ...call, tool_response: { ok: true } });
  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.auditRows.length === 1, 15_000, "the Glob row");
  assert.equal(backend.auditRows[0].would_be, "block");
});
