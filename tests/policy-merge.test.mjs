import test from "node:test";
import assert from "node:assert/strict";
import { mergePolicies } from "../scripts/lib/policy-merge.mjs";

function policy(name, decision, statements) {
  return {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name, description: name },
    defaults: { decision, conflictResolution: "deny_overrides" },
    statements,
  };
}

function stmt(id, effect, action, conditions = []) {
  return {
    id,
    effect,
    principal: { type: "agent", id: "claude-code" },
    action,
    resource: { type: "workspace", scope: "current" },
    conditions,
  };
}

test("strictest default wins (deny > hold > allow)", () => {
  const merged = mergePolicies([
    policy("a", "allow", []),
    policy("b", "hold", []),
    policy("c", "deny", []),
  ]);
  assert.equal(merged.defaults.decision, "deny");
});

test("hold beats allow when no deny present", () => {
  const merged = mergePolicies([policy("a", "allow", []), policy("b", "hold", [])]);
  assert.equal(merged.defaults.decision, "hold");
});

test("same target keeps the strictest effect (forbid > require_approval > permit)", () => {
  const merged = mergePolicies([
    policy("permit-bash", "allow", [stmt("s", "permit", { type: "tool", eq: "Bash" })]),
    policy("forbid-bash", "deny", [stmt("s", "forbid", { type: "tool", eq: "Bash" })]),
  ]);
  const bashRules = merged.statements.filter(
    (s) => s.action.eq === "Bash" || (s.action.in || []).includes("Bash")
  );
  assert.equal(bashRules.length, 1, "identical Bash target should collapse to one rule");
  assert.equal(bashRules[0].effect, "forbid");
});

test("exact duplicate rules collapse to one", () => {
  const a = stmt("read", "permit", { type: "tool", in: ["Read", "Grep"] });
  const merged = mergePolicies([policy("a", "allow", [a]), policy("b", "allow", [a])]);
  assert.equal(merged.statements.length, 1);
});

test("distinct (overlapping) rules are all kept with unique ids", () => {
  const merged = mergePolicies([
    policy("a", "hold", [
      stmt("dup", "forbid", { type: "tool", eq: "Bash" }, [
        { field: "bash.program", op: "in", value: ["rm"] },
      ]),
    ]),
    policy("b", "hold", [
      stmt("dup", "forbid", { type: "tool", eq: "Bash" }, [
        { field: "bash.raw", op: "matches", value: "git push.*--force" },
      ]),
    ]),
  ]);
  assert.equal(merged.statements.length, 2, "different conditions => two distinct rules");
  const ids = merged.statements.map((s) => s.id);
  assert.equal(new Set(ids).size, 2, "ids must be unique");
});

test("result is a valid, normalized armor.policy.v1 document", () => {
  const merged = mergePolicies(
    [
      policy("a", "allow", [stmt("r", "permit", { type: "tool", in: ["Read"] })]),
      policy("b", "deny", [stmt("w", "require_approval", { type: "tool", in: ["Write"] })]),
    ],
    { name: "combo" }
  );
  assert.equal(merged.schemaVersion, "armor.policy.v1");
  assert.equal(merged.defaults.conflictResolution, "deny_overrides");
  assert.equal(merged.metadata.name, "combo");
  assert.equal(merged.statements.length, 2);
});

test("single-policy merge is a normalized no-op", () => {
  const merged = mergePolicies([
    policy("solo", "hold", [stmt("r", "permit", { type: "tool", in: ["Read"] })]),
  ]);
  assert.equal(merged.defaults.decision, "hold");
  assert.equal(merged.statements.length, 1);
});
