import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { evaluatePolicyIr, registerConditionDescriber } from "../scripts/lib/policy-ir.mjs";

const WORKSPACE = path.resolve("/home/user/project");

function workspacePolicy() {
  return {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "architect", description: "write inside workspace" },
    defaults: { decision: "hold", conflictResolution: "deny_overrides" },
    statements: [
      {
        id: "approve-outside",
        effect: "require_approval",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", in: ["Write", "Edit", "MultiEdit"] },
        resource: { type: "file", scope: "current" },
        conditions: [{ field: "file.path", op: "within_workspace", value: false }]
      },
      {
        id: "permit-inside",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", in: ["Write", "Edit", "MultiEdit"] },
        resource: { type: "file", scope: "current" },
        conditions: [{ field: "file.path", op: "within_workspace", value: true }]
      }
    ]
  };
}

test("within_workspace: an in-workspace edit is permitted", () => {
  const decision = evaluatePolicyIr({
    policy: workspacePolicy(),
    toolName: "Edit",
    toolParams: { file_path: path.join(WORKSPACE, "src/app.js") },
    workspaceRoot: WORKSPACE
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.matchedRule.id, "permit-inside");
});

test("within_workspace: an out-of-workspace edit requires approval and explains why", () => {
  const outside = path.resolve("/home/user/other-repo/lib.js");
  const decision = evaluatePolicyIr({
    policy: workspacePolicy(),
    toolName: "Edit",
    toolParams: { file_path: outside },
    workspaceRoot: WORKSPACE
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.matchedRule.id, "approve-outside");
  assert.match(decision.reason, /outside the workspace/);
  assert.match(decision.reason, /approve-outside/);
  assert.ok(decision.reason.includes(outside));
});

test("within_workspace: absolute in-workspace path is not mis-classified (regression)", () => {
  // Before the fix, every absolute path was treated as "not within workspace",
  // so an in-workspace edit never matched permit-inside.
  const inside = path.join(WORKSPACE, "deep/nested/file.txt");
  const decision = evaluatePolicyIr({
    policy: workspacePolicy(),
    toolName: "Write",
    toolParams: { file_path: inside },
    workspaceRoot: WORKSPACE
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.matchedRule.id, "permit-inside");
});

test("within_workspace: unknown workspace root fails safe to approval", () => {
  const decision = evaluatePolicyIr({
    policy: workspacePolicy(),
    toolName: "Edit",
    toolParams: { file_path: path.join(WORKSPACE, "src/app.js") },
    workspaceRoot: "" // can't determine the root → treat as outside
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.matchedRule.id, "approve-outside");
});

test("approval messaging is modular via registerConditionDescriber", () => {
  registerConditionDescriber("network.host", (condition, actual) => `custom host clause for ${actual}`);
  const policy = {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "net", description: "" },
    defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    statements: [
      {
        id: "approve-net",
        effect: "require_approval",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "WebFetch" },
        resource: { type: "network", scope: "current" },
        conditions: [{ field: "network.host", op: "eq", value: "example.com" }]
      }
    ]
  };
  const decision = evaluatePolicyIr({
    policy,
    toolName: "WebFetch",
    toolParams: { url: "https://example.com/x" }
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /custom host clause for example\.com/);
});
