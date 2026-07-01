import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPolicyHash,
  evaluatePolicyIr,
  legacyRulesToPolicyIr,
  normalizePolicyIr,
  parseBashCommand,
  validatePolicyIr,
} from "../scripts/lib/policy-ir.mjs";
import {
  compilePolicyForSdkIntent,
  compilePolicyIrForOpaData,
  compileToOpaInput,
} from "../scripts/lib/policy-compiler.mjs";

function samplePolicy() {
  return {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "intern-policy", description: "test" },
    defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    statements: [
      {
        id: "allow-read",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", in: ["Read", "Grep", "Glob"] },
        resource: { type: "workspace", scope: "current" },
        conditions: [],
      },
      {
        id: "allow-safe-bash",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Bash" },
        resource: { type: "workspace", scope: "current" },
        conditions: [
          { field: "bash.program", op: "in", value: ["ls", "grep"] },
          { field: "bash.hasWriteRedirection", op: "eq", value: false },
        ],
      },
      {
        id: "forbid-db-cloud",
        effect: "forbid",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Bash" },
        resource: { type: "workspace", scope: "current" },
        conditions: [{ field: "bash.program", op: "in", value: ["psql", "gcloud"] }],
      },
    ],
  };
}

test("validatePolicyIr accepts valid ArmorClaude IR", () => {
  const result = validatePolicyIr(samplePolicy());
  assert.equal(result.ok, true);
  assert.equal(result.policy.schemaVersion, "armor.policy.v1");
});

test("validatePolicyIr accepts default hold", () => {
  const policy = samplePolicy();
  policy.defaults.decision = "hold";
  const result = validatePolicyIr(policy);
  assert.equal(result.ok, true);
  assert.equal(result.policy.defaults.decision, "hold");
});

test("validatePolicyIr rejects unknown fields and operators", () => {
  const policy = samplePolicy();
  policy.extra = true;
  policy.statements[0].conditions.push({ field: "bash.program", op: "contains", value: "ls" });
  const result = validatePolicyIr(policy);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("Unknown policy field")));
  assert.ok(result.errors.some((e) => e.includes("Unknown condition op")));
});

test("legacy rules migrate to IR as one-time compatibility input", () => {
  const ir = legacyRulesToPolicyIr([
    { id: "p1", action: "deny", tool: "Write" },
    { id: "p2", action: "require_approval", tool: "Bash" },
  ]);
  assert.equal(ir.schemaVersion, "armor.policy.v1");
  assert.equal(ir.statements[0].effect, "forbid");
  assert.equal(ir.statements[0].action.eq, "Write");
  assert.equal(ir.statements[1].effect, "require_approval");
  assert.equal(ir.statements[1].action.eq, "Bash");
});

test("legacy bare Bash program rules migrate to Bash program conditions", () => {
  const ir = legacyRulesToPolicyIr([
    { id: "legacy-ls", action: "allow", tool: "ls" },
    { id: "legacy-gcloud", action: "deny", tool: "gcloud" },
  ]);
  assert.deepEqual(ir.statements[0], {
    id: "legacy-ls",
    effect: "permit",
    principal: { type: "agent", id: "claude-code" },
    action: { type: "tool", eq: "Bash" },
    resource: { type: "workspace", scope: "current" },
    conditions: [
      { field: "bash.program", op: "in", value: ["ls"] },
      { field: "bash.hasWriteRedirection", op: "eq", value: false },
    ],
  });
  assert.deepEqual(ir.statements[1], {
    id: "legacy-gcloud",
    effect: "forbid",
    principal: { type: "agent", id: "claude-code" },
    action: { type: "tool", eq: "Bash" },
    resource: { type: "workspace", scope: "current" },
    conditions: [{ field: "bash.program", op: "in", value: ["gcloud"] }],
  });
});

test("normalizePolicyIr repairs stale split tool statements and Bash program tools", () => {
  const repaired = normalizePolicyIr({
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "stale", description: "" },
    defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    statements: [
      {
        id: "allow-read-tools-Read",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Read" },
        resource: { type: "workspace", scope: "current" },
        conditions: [],
      },
      {
        id: "allow-read-tools-Grep",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Grep" },
        resource: { type: "workspace", scope: "current" },
        conditions: [],
      },
      {
        id: "allow-read-tools-Glob",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Glob" },
        resource: { type: "workspace", scope: "current" },
        conditions: [],
      },
      {
        id: "policy1",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "ls" },
        resource: { type: "workspace", scope: "current" },
        conditions: [],
      },
    ],
  });
  assert.deepEqual(repaired.statements[0].action, { type: "tool", in: ["Read", "Grep", "Glob"] });
  assert.equal(repaired.statements[0].id, "allow-read-tools");
  assert.equal(repaired.statements[1].action.eq, "Bash");
  assert.deepEqual(repaired.statements[1].conditions, [
    { field: "bash.program", op: "in", value: ["ls"] },
    { field: "bash.hasWriteRedirection", op: "eq", value: false },
  ]);
});

test("evaluatePolicyIr enforces default deny and forbid overrides", () => {
  const policy = samplePolicy();
  assert.equal(evaluatePolicyIr({ policy, toolName: "Read", toolParams: {} }).allowed, true);
  assert.equal(evaluatePolicyIr({ policy, toolName: "Write", toolParams: {} }).allowed, false);
  assert.equal(
    evaluatePolicyIr({ policy, toolName: "Bash", toolParams: { command: "ls -la" } }).allowed,
    true
  );
  const denied = evaluatePolicyIr({ policy, toolName: "Bash", toolParams: { command: "psql db" } });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /forbid-db-cloud/);
});

test("evaluatePolicyIr maps default hold to approval for unmatched tools", () => {
  const policy = normalizePolicyIr({
    ...samplePolicy(),
    defaults: { decision: "hold", conflictResolution: "deny_overrides" },
    statements: [],
  });
  const held = evaluatePolicyIr({ policy, toolName: "Write", toolParams: { file_path: "a.txt" } });
  assert.equal(held.allowed, false);
  assert.match(held.reason, /default hold: no statement matched tool Write/);
  assert.equal(held.matchedRule.effect, "require_approval");
  assert.equal(held.matchedRule.id, "default-hold");
});

test("evaluatePolicyIr blocks unsafe Bash redirection under safe bash policy", () => {
  const policy = samplePolicy();
  const denied = evaluatePolicyIr({
    policy,
    toolName: "Bash",
    toolParams: { command: "ls > out.txt" },
  });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /default deny: no statement matched tool Bash/);
});

test("validatePolicyIr accepts current Claude Code tool names", () => {
  const policy = samplePolicy();
  policy.statements.push({
    id: "allow-claude-helpers",
    effect: "permit",
    principal: { type: "agent", id: "claude-code" },
    action: {
      type: "tool",
      in: [
        "Explore",
        "Agent",
        "Skill",
        "AskUserQuestion",
        "LSP",
        "PowerShell",
        "ToolSearch",
        "TaskCreate",
        "Workflow",
      ],
    },
    resource: { type: "workspace", scope: "current" },
    conditions: [],
  });
  assert.equal(validatePolicyIr(policy).ok, true);
});

test("parseBashCommand extracts program and redirection", () => {
  assert.deepEqual(parseBashCommand("FOO=1 ls -la > out.txt"), {
    raw: "FOO=1 ls -la > out.txt",
    program: "ls",
    hasWriteRedirection: true,
  });
});

test("canonicalPolicyHash is stable across object key order", () => {
  const a = samplePolicy();
  const b = normalizePolicyIr(JSON.parse(JSON.stringify(a)));
  assert.equal(canonicalPolicyHash(a), canonicalPolicyHash(b));
});

test("compilePolicyIrForOpaData preserves IR statements for OPA bundles", () => {
  const data = compilePolicyIrForOpaData(samplePolicy());
  assert.equal(data.format, "armorclaude-ir-v1");
  assert.equal(data.statements.length, 3);
  assert.equal(data.defaults.decision, "deny");
});

test("compilePolicyIrForOpaData preserves default hold for OPA bundles", () => {
  const policy = samplePolicy();
  policy.defaults.decision = "hold";
  const data = compilePolicyIrForOpaData(policy);
  assert.equal(data.defaults.decision, "hold");
});

test("compilePolicyForSdkIntent emits CSRG path allow and tool metadata", () => {
  const policy = legacyRulesToPolicyIr([
    { id: "allow-bash", action: "allow", tool: "Bash" },
    { id: "deny-write", action: "deny", tool: "Write" },
  ]);
  const compiled = compilePolicyForSdkIntent(policy, "hash-123");
  assert.deepEqual(compiled.allow, ["*"]);
  assert.deepEqual(compiled.deny, []);
  assert.deepEqual(compiled.allowed_tools, ["Bash"]);
  assert.deepEqual(compiled.denied_tools, ["Write"]);
  assert.equal(compiled.metadata.source, "armorclaude");
  assert.equal(compiled.metadata.policyHash, "hash-123");
});

test("compileToOpaInput preserves IR statements and emits OPA clientRule envelope", () => {
  const input = compileToOpaInput(samplePolicy(), "Grep", {});
  const allowedTools = input.policies.flatMap((policy) => policy.clientRule.allowedTools);
  assert.ok(allowedTools.includes("Read"));
  assert.ok(allowedTools.includes("Grep"));
  assert.ok(allowedTools.includes("Glob"));
  assert.equal(input.policy.statements.length, 3);
});
