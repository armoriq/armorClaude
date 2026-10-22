import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { startBackend, startHookSession } from "./helpers/hook-session.mjs";

const POLICY_DOCUMENT = JSON.parse(
  readFileSync(new URL("./fixtures/v2-agent-policy.json", import.meta.url), "utf8")
);
const BUNDLE = {
  orgId: "org-test",
  agents: [
    {
      agentId: "agent-claude-code",
      name: "claude-code",
      inactive: false,
      policy: {
        policyId: "policy-1",
        name: "args-and-holds",
        policyHash: null,
        document: POLICY_DOCUMENT,
      },
      tools: [],
      members: [],
    },
  ],
};

function tokenReply(planId) {
  return [
    200,
    {
      success: true,
      plan_id: planId,
      plan_hash: "plan-hash",
      intent_reference: "intent-ref",
      jwt_token: "jwt-test",
      token: { issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
      step_proofs: [],
    },
  ];
}

function v2Backend(planId, { bundle = () => [200, BUNDLE], enforce } = {}) {
  return startBackend({
    "GET /policy/bundles/current": bundle,
    "POST /iap/sdk/token": () => tokenReply(planId),
    "POST /iap/sdk/enforce": (body) => [200, enforce(body)],
    "POST /delegation/request": () => [201, { delegationId: "deleg-1", status: "pending" }],
  });
}

const decisionOf = (output) => output?.hookSpecificOutput?.permissionDecision ?? "allow";
const reasonOf = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? "";
const routed = (backend, route) => backend.requests.filter((r) => r.route.startsWith(route));

test("the minted plan carries each step's tool input as arguments, the field the backend's v2 plan check reads", async (t) => {
  const backend = await v2Backend(randomUUID());
  const { hook } = await startHookSession(t, backend);
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  const [mint] = routed(backend, "POST /iap/sdk/token");
  assert.ok(mint, "no token mint");
  assert.deepEqual(mint.body.plan.steps[0].arguments, { command: "ls" });
});

test("each call is decided from the org's v2 bundle with its real arguments, without a backend round trip", async (t) => {
  const backend = await v2Backend(randomUUID());
  const { hook } = await startHookSession(t, backend);
  const bash = (command) =>
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

  assert.equal(decisionOf(await bash("ls -la")), "allow");
  const blocked = await bash("rm -rf build");
  assert.equal(decisionOf(blocked), "deny", JSON.stringify(blocked));
  assert.match(reasonOf(blocked), /block:Bash#0/);

  assert.equal(routed(backend, "POST /iap/sdk/enforce").length, 0);
  const fetches = routed(backend, "GET /policy/bundles/current");
  assert.equal(fetches.length, 1);
  assert.match(fetches[0].route, /agent=claude-code/);
});

test("read-only tools and MCP tools get the v2 verdict too", async (t) => {
  const backend = await v2Backend(randomUUID());
  const { hook } = await startHookSession(t, backend);
  const pre = (tool_name, tool_input) =>
    hook({ hook_event_name: "PreToolUse", tool_name, tool_input });

  assert.equal(decisionOf(await pre("Read", { file_path: "/workspace/.env" })), "deny");
  assert.equal(decisionOf(await pre("Read", { file_path: "/workspace/README.md" })), "allow");
  const mcp = await pre("mcp__github__create_issue", { repo: "prod", title: "x" });
  assert.equal(decisionOf(mcp), "deny", JSON.stringify(mcp));
  assert.match(reasonOf(mcp), /block:create_issue#0/);
});

test("a v2 hold asks, files one delegation request without an amount, and the approved retry runs", async (t) => {
  const planId = randomUUID();
  let approved = false;
  const backend = await v2Backend(planId, {
    enforce: () =>
      approved
        ? { allowed: true, enforcementAction: "allow", reason: "approved_delegation" }
        : {
            allowed: false,
            enforcementAction: "hold",
            reason: "hold:Write#0",
            requiresApproval: true,
          },
  });
  const { hook } = await startHookSession(t, backend);
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  const write = {
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/workspace/secrets/a.txt", content: "hi" },
  };

  const held = await hook(write);
  assert.equal(decisionOf(held), "ask", JSON.stringify(held));
  assert.match(reasonOf(held), /hold:Write#0/);
  assert.match(reasonOf(held), /deleg-1/);
  const [enforce] = routed(backend, "POST /iap/sdk/enforce");
  assert.deepEqual(enforce.body.arguments, write.tool_input);
  assert.equal(enforce.body.tool, "Write");
  assert.equal(enforce.body.agent_id, "claude-code");
  assert.equal(enforce.body.user_email, "dev@example.com");
  assert.equal(enforce.body.intent_token.plan_id, planId);
  const [request] = routed(backend, "POST /delegation/request");
  assert.equal(request.body.tool, "Write");
  assert.equal(request.body.planId, planId);
  assert.deepEqual(request.body.arguments, write.tool_input);
  assert.equal(Object.hasOwn(request.body, "amount"), false);

  assert.equal(decisionOf(await hook(write)), "ask");
  assert.equal(routed(backend, "POST /delegation/request").length, 1);

  approved = true;
  assert.equal(decisionOf(await hook(write)), "allow");
});

test("in enforce mode a call is denied when the v2 bundle cannot be fetched", async (t) => {
  const backend = await v2Backend(randomUUID(), { bundle: () => [503, { message: "down" }] });
  const { hook } = await startHookSession(t, backend);
  const output = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  assert.equal(decisionOf(output), "deny", JSON.stringify(output));
  assert.match(reasonOf(output), /policy-bundle-unavailable/);
});
