import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPolicyHash,
  evaluatePolicyIr,
  legacyRulesToPolicyIr,
  normalizePolicyIr,
  parseBashCommand,
  policyIrToLegacyRules,
  validatePolicyIr
} from "../scripts/lib/policy-ir.mjs";
import { compilePolicyForSdkIntent, compilePolicyIrForOpaData, compileToOpaInput } from "../scripts/lib/policy-compiler.mjs";

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
        conditions: []
      },
      {
        id: "allow-safe-bash",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Bash" },
        resource: { type: "workspace", scope: "current" },
        conditions: [
          { field: "bash.program", op: "in", value: ["ls", "grep"] },
          { field: "bash.hasWriteRedirection", op: "eq", value: false }
        ]
      },
      {
        id: "forbid-db-cloud",
        effect: "forbid",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Bash" },
        resource: { type: "workspace", scope: "current" },
        conditions: [{ field: "bash.program", op: "in", value: ["psql", "gcloud"] }]
      }
    ]
  };
}

test("validatePolicyIr accepts valid ArmorClaude IR", () => {
  const result = validatePolicyIr(samplePolicy());
  assert.equal(result.ok, true);
  assert.equal(result.policy.schemaVersion, "armor.policy.v1");
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

test("legacy rules migrate to IR and back", () => {
  const ir = legacyRulesToPolicyIr([
    { id: "p1", action: "deny", tool: "Write" },
    { id: "p2", action: "require_approval", tool: "Bash" }
  ]);
  assert.equal(ir.schemaVersion, "armor.policy.v1");
  assert.equal(ir.statements[0].effect, "forbid");
  assert.deepEqual(policyIrToLegacyRules(ir), [
    { id: "p1", action: "deny", tool: "Write" },
    { id: "p2", action: "require_approval", tool: "Bash" }
  ]);
});

test("evaluatePolicyIr enforces default deny and forbid overrides", () => {
  const policy = samplePolicy();
  assert.equal(evaluatePolicyIr({ policy, toolName: "Read", toolParams: {} }).allowed, true);
  assert.equal(evaluatePolicyIr({ policy, toolName: "Write", toolParams: {} }).allowed, false);
  assert.equal(evaluatePolicyIr({ policy, toolName: "Bash", toolParams: { command: "ls -la" } }).allowed, true);
  const denied = evaluatePolicyIr({ policy, toolName: "Bash", toolParams: { command: "psql db" } });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /forbid-db-cloud/);
});

test("evaluatePolicyIr blocks unsafe Bash redirection under safe bash policy", () => {
  const policy = samplePolicy();
  const denied = evaluatePolicyIr({ policy, toolName: "Bash", toolParams: { command: "ls > out.txt" } });
  assert.equal(denied.allowed, false);
  assert.match(denied.reason, /default deny: no statement matched tool Bash/);
});

test("validatePolicyIr accepts Claude Code Explore and Skill tool names", () => {
  const policy = samplePolicy();
  policy.statements.push({
    id: "allow-claude-helpers",
    effect: "permit",
    principal: { type: "agent", id: "claude-code" },
    action: { type: "tool", in: ["Explore", "Skill"] },
    resource: { type: "workspace", scope: "current" },
    conditions: []
  });
  assert.equal(validatePolicyIr(policy).ok, true);
});

test("parseBashCommand extracts program and redirection", () => {
  assert.deepEqual(parseBashCommand("FOO=1 ls -la > out.txt"), {
    raw: "FOO=1 ls -la > out.txt",
    program: "ls",
    hasWriteRedirection: true
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

test("compilePolicyForSdkIntent emits CSRG path allow and tool metadata", () => {
  const policy = legacyRulesToPolicyIr([
    { id: "allow-bash", action: "allow", tool: "Bash" },
    { id: "deny-write", action: "deny", tool: "Write" }
  ]);
  const compiled = compilePolicyForSdkIntent(policy, "hash-123");
  assert.deepEqual(compiled.allow, ["*"]);
  assert.deepEqual(compiled.deny, []);
  assert.deepEqual(compiled.allowed_tools, ["Bash"]);
  assert.deepEqual(compiled.denied_tools, ["Write"]);
  assert.equal(compiled.metadata.source, "armorclaude");
  assert.equal(compiled.metadata.policyHash, "hash-123");
});

test("compileToOpaInput expands IR multi-tool statements for OPA compatibility", () => {
  const input = compileToOpaInput(samplePolicy(), "Grep", {});
  const allowedTools = input.policies.flatMap((policy) => policy.clientRule.allowedTools);
  assert.ok(allowedTools.includes("Read"));
  assert.ok(allowedTools.includes("Grep"));
  assert.ok(allowedTools.includes("Glob"));
});

test("policyIrToLegacyRules orders deny before allow for fail-closed compatibility", () => {
  const rules = policyIrToLegacyRules(samplePolicy());
  assert.equal(rules[0].action, "deny");
  assert.equal(rules[0].tool, "Bash");
});
