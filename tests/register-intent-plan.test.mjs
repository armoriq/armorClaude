import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { savePolicyState } from "../scripts/lib/policy.mjs";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";

const policyMcp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "policy-mcp.mjs"
);

const POLICY = {
  schemaVersion: "armor.policy.v1",
  kind: "PolicyProfile",
  metadata: { name: "enforcing", description: "" },
  defaults: { decision: "allow", conflictResolution: "deny_overrides" },
  statements: [
    {
      id: "forbid-webfetch",
      effect: "forbid",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "WebFetch" },
      resource: { type: "workspace", scope: "current" },
      conditions: [],
    },
  ],
};

const tokenReply = (planId) => () => [
  200,
  {
    success: true,
    plan_id: planId,
    plan_hash: "plan-hash",
    intent_reference: "intent-ref",
    token: { issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
    step_proofs: [],
  },
];

async function registerIntentPlan(t, env, args) {
  const client = new Client({ name: "register-intent-plan-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [policyMcp],
      env,
      stderr: "ignore",
    })
  );
  t.after(() => client.close());
  const result = await client.callTool({ name: "register_intent_plan", arguments: args });
  return result.content[0].text;
}

async function enforcedSession(t, planId) {
  const backend = await startBackend({ "POST /iap/sdk/token": tokenReply(planId) });
  const session = await startHookSession(t, backend);
  await savePolicyState(path.join(session.dataDir, "policy.json"), { version: 1, policy: POLICY });
  await session.hook({ hook_event_name: "SessionStart", source: "startup" });
  await session.hook({ hook_event_name: "UserPromptSubmit", prompt: "read the readme" });
  return { ...session, backend };
}

test("the first Read after register_intent_plan is audited against the registered plan", async (t) => {
  const planId = randomUUID();
  const { backend, env, sessionId, hook } = await enforcedSession(t, planId);
  const reply = await registerIntentPlan(t, env, {
    goal: "read the readme",
    steps: [{ action: "Read", description: "read README.md" }],
  });
  assert.match(reply, /^Intent registered: 1 steps/);

  const read = { tool_name: "Read", tool_input: { file_path: "/repo/README.md" } };
  assert.equal(await hook({ hook_event_name: "PreToolUse", ...read }), null);
  await hook({ hook_event_name: "PostToolUse", ...read, tool_response: { content: "readme" } });
  await hook({ hook_event_name: "Stop" });

  await waitFor(() => backend.auditRows.length > 0, 15_000, "the Read audit row");
  assert.deepEqual(
    backend.auditRows.map((row) => [row.tool, row.status, row.plan_id, row.session_id]),
    [["Read", "success", planId, sessionId]]
  );
});

test("register_intent_plan with no active session stores nothing and asks for a prompt first", async (t) => {
  const backend = await startBackend({ "POST /iap/sdk/token": tokenReply(randomUUID()) });
  const { env, dataDir } = await startHookSession(t, backend);
  const reply = await registerIntentPlan(t, env, {
    goal: "read the readme",
    steps: [{ action: "Read", description: "read README.md" }],
  });
  assert.match(reply, /^Plan rejected: no active ArmorClaude session/);
  assert.deepEqual(
    readdirSync(dataDir).filter((name) => /plan|runtime/.test(name)),
    []
  );
  assert.deepEqual(
    backend.requests.filter((r) => r.route === "POST /iap/sdk/token"),
    []
  );
});
