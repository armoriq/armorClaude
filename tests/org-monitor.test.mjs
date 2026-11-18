import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { savePolicyState } from "../scripts/lib/policy.mjs";
import { markReloginRequired } from "../scripts/lib/relogin.mjs";
import { API_KEY, startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";

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

async function orgSession(t, active) {
  const backend = await startBackend({
    "GET /policies/profiles/active": () => [200, { version: 1, policy: null, ...active }],
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
  test(`an org that ${label} runs every call silently and records what Enforce would have done`, async (t) => {
    const { hook, backend, start } = await orgSession(t, active);
    assert.equal(start, null);
    const prompt = await hook({ hook_event_name: "UserPromptSubmit", prompt: "tidy the repo" });
    assert.equal(prompt, null);

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
      backend.auditRows.map((r) => [r.tool, r.status, r.would_be, r.would_be_code]),
      calls.map(([tool, , wouldBe, code]) => [tool, "success", wouldBe, code])
    );
    const asked = backend.requests.map((r) => r.route);
    assert.equal(asked.filter((r) => /\/iap\/sdk\/enforce|\/delegation/.test(r)).length, 0);
  });
}

test("an org that says Enforce blocks the call", async (t) => {
  const { hook } = await orgSession(t, { enforcementMode: "enforce" });
  const out = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Glob",
    tool_input: { pattern: "*" },
  });
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});

test("an org in Monitor shows nothing in the session from the session start that learns it, and an Enforce org shows its sign-in line from the same point", async (t) => {
  const mode = { enforcementMode: "shadow" };
  const backend = await startBackend({
    "GET /policies/profiles/active": () => [200, { version: 1, policy: null, ...mode }],
  });
  const { hook, dataDir } = await startHookSession(t, backend, { ARMORIQ_ORG_MODE: "" });
  markReloginRequired({ dataDir, observabilityEndpoint: backend.url, apiKey: API_KEY });

  assert.equal(await hook({ hook_event_name: "SessionStart" }), null);
  assert.equal(await hook({ hook_event_name: "UserPromptSubmit", prompt: "hi" }), null);

  mode.enforcementMode = "enforce";
  const start = await hook({ hook_event_name: "SessionStart" });
  assert.match(start?.systemMessage ?? "", /sign in again/);

  mode.enforcementMode = "shadow";
  assert.equal(await hook({ hook_event_name: "SessionStart" }), null);
});
