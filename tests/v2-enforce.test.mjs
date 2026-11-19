import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { daemonLogPath } from "../scripts/lib/daemon-log.mjs";
import { savePolicyState } from "../scripts/lib/policy.mjs";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";

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
  const fetches = routed(backend, "GET /policy/bundles/current").map((r) => r.route);
  assert.deepEqual(
    fetches.map((route) => new URL(route.split(" ")[1], "http://x").searchParams.get("agent")),
    ["armorclaude", "claude-code"],
    "a backend without slug resolution answers armorclaude with no agent, so the legacy name is read"
  );
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

test("a v2 hold stops the call, files one delegation request without an amount, and the approved retry runs", async (t) => {
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
  assert.equal(decisionOf(held), "deny", JSON.stringify(held));
  assert.match(reasonOf(held), /ArmorIQ policy "args-and-holds" holds Write for approval/);
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

  assert.equal(decisionOf(await hook(write)), "deny");
  assert.equal(routed(backend, "POST /delegation/request").length, 1);

  approved = true;
  assert.equal(decisionOf(await hook(write)), "allow");
});

test("in Monitor a v2 hold runs the call and files no approval request, even with a plan on the session", async (t) => {
  const planId = randomUUID();
  const backend = await v2Backend(planId, {
    enforce: () => ({ allowed: false, enforcementAction: "hold", reason: "hold:Write#0" }),
  });
  const { hook, dataDir, sessionId } = await startHookSession(t, backend, { ARMORIQ_ORG_MODE: "" });
  const token = { planId, jwtToken: "jwt-test", rawToken: { plan_id: planId } };
  await writeFile(
    path.join(dataDir, "runtime.json"),
    JSON.stringify({ sessions: { [sessionId]: { intentTokenRaw: JSON.stringify(token) } } })
  );
  const held = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/workspace/secrets/a.txt", content: "hi" },
  });
  assert.equal(held, null);
  assert.deepEqual(
    [...routed(backend, "POST /iap/sdk/enforce"), ...routed(backend, "POST /delegation/request")],
    []
  );
});

test("in enforce mode a call is denied when the v2 bundle cannot be fetched", async (t) => {
  const backend = await v2Backend(randomUUID(), { bundle: () => [403, { message: "forbidden" }] });
  const { hook } = await startHookSession(t, backend);
  const output = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  });
  assert.equal(decisionOf(output), "deny", JSON.stringify(output));
  assert.match(reasonOf(output), /policy-bundle-unavailable/);
});

const statement = (id, tool, effect, conditions = []) => ({
  id,
  subject: null,
  match: { tool, keyTier: "exact", order: 0 },
  effect,
  conditions,
  expiresAt: "never",
  provenance: { ruleKey: tool, variant: 0, source: "yaml", layer: "floor" },
});
const commandMatches = (value) => [
  { field: "args.command", op: "regex", value, schemaBinding: { schemaHash: null } },
];
const ORG_DOCUMENT = {
  ...POLICY_DOCUMENT,
  target: { org: "*" },
  layer: "floor",
  statements: [statement("org-curl", "Bash", "block", commandMatches("curl"))],
};
const entry = (policyId, name, document, targetType, status = "active") => ({
  policyId,
  name,
  policyHash: `sha256:${policyId}`,
  document,
  targetType,
  status,
});

function slugBundle(policies) {
  return {
    orgId: "org-test",
    agents: [
      {
        agentId: "agent-claude-code",
        name: "armorclaude",
        registeredName: "claude-code",
        registered: true,
        inactive: false,
        policy: null,
        policies,
        tools: [],
        members: [],
      },
    ],
  };
}

const bash = (hook, command) =>
  hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

test("an org-wide policy binds as the floor, so the agent's own allow cannot loosen it, and the deny names the policy", async (t) => {
  const bundle = slugBundle([
    entry("org-1", "no-curl-anywhere", ORG_DOCUMENT, "org"),
    entry("agent-1", "args-and-holds", POLICY_DOCUMENT, "agent"),
  ]);
  const backend = await v2Backend(randomUUID(), { bundle: () => [200, bundle] });
  const { hook } = await startHookSession(t, backend);

  const curl = await bash(hook, "curl https://example.com");
  assert.equal(decisionOf(curl), "deny", JSON.stringify(curl));
  assert.match(reasonOf(curl), /ArmorIQ policy "no-curl-anywhere" blocked Bash/);
  const rm = await bash(hook, "rm -rf build");
  assert.match(reasonOf(rm), /ArmorIQ policy "args-and-holds" blocked Bash/);
  assert.equal(decisionOf(await bash(hook, "ls")), "allow");

  const agents = routed(backend, "GET /policy/bundles/current").map((r) => r.route);
  assert.ok(
    agents.every((route) => route.includes("agent=armorclaude")),
    agents.join(", ")
  );

  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.auditRows.length >= 2, 15_000, "the blocked rows");
  const curlRow = backend.auditRows.find((row) => row.input.command?.startsWith("curl"));
  assert.deepEqual(curlRow.input.armoriq_policy, {
    source: "v2",
    policy_id: "org-1",
    policy_name: "no-curl-anywhere",
    policy_hash: "sha256:org-1",
    rule: "Bash#0",
  });
  assert.equal(curlRow.output.matchedPolicy.name, "no-curl-anywhere");
});

test("in Monitor a workspace-floor block runs the call and its row records the would-be with the v2 source", async (t) => {
  const bundle = slugBundle([
    entry("org-1", "no-curl-anywhere", ORG_DOCUMENT, "org"),
    entry("agent-1", "args-and-holds", POLICY_DOCUMENT, "agent"),
  ]);
  const backend = await v2Backend(randomUUID(), { bundle: () => [200, bundle] });
  const { hook } = await startHookSession(t, backend, { ARMORIQ_ORG_MODE: "" });
  const call = {
    tool_name: "Bash",
    tool_use_id: "toolu-curl",
    tool_input: { command: "curl https://example.com" },
  };

  assert.equal(await hook({ hook_event_name: "PreToolUse", ...call }), null);
  await hook({ hook_event_name: "PostToolUse", ...call, tool_response: { stdout: "ok" } });
  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.auditRows.length >= 1, 15_000, "the monitored row");

  assert.deepEqual(
    backend.auditRows.map((row) => [row.status, row.would_be, row.would_be_code]),
    [["success", "block", "policy_v2_block"]]
  );
  assert.match(
    backend.auditRows[0].would_be_reason,
    /ArmorIQ policy "no-curl-anywhere" blocked Bash/
  );
  assert.equal(backend.auditRows[0].input.armoriq_policy.source, "v2");
  assert.equal(backend.auditRows[0].input.armoriq_policy.policy_name, "no-curl-anywhere");
  assert.equal(routed(backend, "POST /delegation/request").length, 0);
});

test("a shadow policy is evaluated and logged but never enforced", async (t) => {
  const shadowDocument = {
    ...POLICY_DOCUMENT,
    statements: [statement("shadow-ls", "Bash", "block", commandMatches("^ls"))],
  };
  const bundle = slugBundle([
    entry("agent-1", "args-and-holds", POLICY_DOCUMENT, "agent"),
    entry("shadow-1", "trial-no-ls", shadowDocument, "agent", "shadow"),
  ]);
  const backend = await v2Backend(randomUUID(), { bundle: () => [200, bundle] });
  const { hook, dataDir } = await startHookSession(t, backend);

  assert.equal(decisionOf(await bash(hook, "ls -la")), "allow");
  const log = readFileSync(daemonLogPath(dataDir), "utf8");
  assert.match(log, /shadow: policy "trial-no-ls" would block Bash \(not enforced\)/);
});

test("with no v2 policy for the agent the v1 policy decides, and the row names the v1 rule", async (t) => {
  const backend = await v2Backend(randomUUID(), {
    bundle: () => [200, { orgId: "org-test", agents: [] }],
  });
  const { hook, dataDir } = await startHookSession(t, backend);
  await savePolicyState(path.join(dataDir, "policy.json"), {
    version: 1,
    policy: {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "v1-fallback", description: "" },
      defaults: { decision: "allow", conflictResolution: "deny_overrides" },
      statements: [
        {
          id: "no-glob",
          effect: "forbid",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", eq: "Glob" },
          resource: { type: "workspace", scope: "current" },
          conditions: [],
        },
      ],
    },
  });

  const glob = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Glob",
    tool_input: { pattern: "*" },
  });
  assert.equal(decisionOf(glob), "deny", JSON.stringify(glob));
  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.auditRows.length === 1, 15_000, "the blocked row");
  assert.deepEqual(backend.auditRows[0].input.armoriq_policy, {
    source: "local",
    rule_id: "no-glob",
  });
});

test("a change in the active v2 policy since the session's last call shows the person one line", async (t) => {
  const bundle = slugBundle([entry("agent-2", "args-and-holds-v2", POLICY_DOCUMENT, "agent")]);
  const backend = await v2Backend(randomUUID(), { bundle: () => [200, bundle] });
  const session = await startHookSession(t, backend);
  await writeFile(
    path.join(session.dataDir, "runtime.json"),
    JSON.stringify({ sessions: { [session.sessionId]: { v2PolicyKey: "agent-1@sha256:agent-1" } } })
  );

  const first = await bash(session.hook, "ls");
  assert.equal(first?.systemMessage, 'ArmorIQ policy updated: now enforcing "args-and-holds-v2".');
  const second = await bash(session.hook, "ls");
  assert.equal(second?.systemMessage, undefined);
});

const byAgent = (replies) => (_body, req) =>
  replies[new URL(req.url, "http://x").searchParams.get("agent")] ?? [404, {}];
const noAgents = [200, { orgId: "org-test", agents: [] }];

test("on a backend without slug resolution, an unreadable legacy bundle still blocks instead of falling back to v1", async (t) => {
  const backend = await v2Backend(randomUUID(), {
    bundle: byAgent({ armorclaude: noAgents, "claude-code": [403, { message: "forbidden" }] }),
  });
  const { hook } = await startHookSession(t, backend);
  const output = await bash(hook, "ls");
  assert.equal(decisionOf(output), "deny", JSON.stringify(output));
  assert.match(reasonOf(output), /policy-bundle-unavailable/);
});

test("on a backend without slug resolution, an inactive legacy agent still blocks", async (t) => {
  const inactive = { ...BUNDLE.agents[0], inactive: true, policy: null };
  const backend = await v2Backend(randomUUID(), {
    bundle: byAgent({
      armorclaude: noAgents,
      "claude-code": [200, { orgId: "org-test", agents: [inactive] }],
    }),
  });
  const { hook } = await startHookSession(t, backend);
  const output = await bash(hook, "ls");
  assert.equal(decisionOf(output), "deny", JSON.stringify(output));
  assert.match(reasonOf(output), /agent_inactive/);
});

const heldWrite = {
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: "/workspace/secrets/a.txt", content: "hi" },
};
const holdOnce = () => ({
  allowed: false,
  enforcementAction: "hold",
  reason: "hold:Write#0",
  requiresApproval: true,
});

test("a hold read from the product-slug bundle is enforced as the agent the intent token was minted for", async (t) => {
  const bundle = slugBundle([entry("agent-1", "args-and-holds", POLICY_DOCUMENT, "agent")]);
  const backend = await v2Backend(randomUUID(), { bundle: () => [200, bundle], enforce: holdOnce });
  const { hook } = await startHookSession(t, backend);
  await bash(hook, "ls");

  const held = await hook(heldWrite);
  assert.equal(decisionOf(held), "deny", JSON.stringify(held));
  assert.match(reasonOf(held), /Approval request deleg-1 is waiting for another member/);
  const [mint] = routed(backend, "POST /iap/sdk/token");
  const [enforce] = routed(backend, "POST /iap/sdk/enforce");
  assert.equal(mint.body.agent_id, "claude-code");
  assert.equal(enforce.body.agent_id, mint.body.agent_id);
  assert.equal(routed(backend, "POST /delegation/request").length, 1);
});

const capturePrompt = async (t, bundle) => {
  const backend = await v2Backend(randomUUID(), { bundle: () => [200, bundle] });
  const { hook } = await startHookSession(t, backend);
  const prompt = await hook({ hook_event_name: "UserPromptSubmit", prompt: "write hello.txt" });
  return prompt?.hookSpecificOutput?.additionalContext ?? "";
};

test("in capture mode the prompt directive names the v2 policies that still block or hold calls", async (t) => {
  const directive = await capturePrompt(
    t,
    slugBundle([
      entry("org-1", "no-curl-anywhere", ORG_DOCUMENT, "org"),
      entry("agent-1", "args-and-holds", POLICY_DOCUMENT, "agent"),
    ])
  );
  assert.match(directive, /ArmorClaude intent capture is active/);
  assert.match(
    directive,
    /ArmorIQ policies "no-curl-anywhere", "args-and-holds" still decide each call/
  );
  assert.doesNotMatch(directive, /blocks none/);
});

test("in capture mode with no active v2 policy the directive says nothing is blocked", async (t) => {
  const directive = await capturePrompt(t, { orgId: "org-test", agents: [] });
  assert.match(directive, /The current policy blocks none of them/);
});
