import { normalizePolicyIr, validatePolicyIr } from "./policy-ir.mjs";

// Restrictiveness ranks. Merging always keeps the STRICTER choice so combining
// bundles can never make the resulting policy more permissive than any input.
const DEFAULT_RANK = { allow: 0, hold: 1, deny: 2 };
const EFFECT_RANK = { permit: 0, require_approval: 1, forbid: 2 };

function ruleKey(statement) {
  return JSON.stringify([
    statement.principal,
    statement.action,
    statement.resource,
    statement.conditions,
  ]);
}

export function mergePolicies(policies, { name = "custom-merged", description } = {}) {
  const list = Array.isArray(policies) ? policies : [policies];
  if (list.length === 0) {
    throw new Error("mergePolicies requires at least one policy");
  }
  const normalized = list.map((p) => normalizePolicyIr(p));

  let decision = "allow";
  for (const p of normalized) {
    if ((DEFAULT_RANK[p.defaults.decision] ?? 0) > (DEFAULT_RANK[decision] ?? 0)) {
      decision = p.defaults.decision;
    }
  }

  const byKey = new Map();
  for (const p of normalized) {
    for (const statement of p.statements) {
      const key = ruleKey(statement);
      const existing = byKey.get(key);
      if (!existing || (EFFECT_RANK[statement.effect] ?? 0) > (EFFECT_RANK[existing.effect] ?? 0)) {
        byKey.set(key, statement);
      }
    }
  }

  const usedIds = new Set();
  const statements = [];
  for (const statement of byKey.values()) {
    const base = statement.id || "stmt";
    let id = base;
    let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id);
    statements.push({ ...statement, id });
  }

  const merged = {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: {
      name,
      description:
        description ??
        `Merged (most-restrictive) from: ${normalized.map((p) => p.metadata.name).join(", ")}`,
    },
    defaults: { decision, conflictResolution: "deny_overrides" },
    statements,
  };

  const result = validatePolicyIr(merged);
  if (!result.ok) {
    throw new Error(`Merged policy is invalid: ${result.errors.join("; ")}`);
  }
  return result.policy;
}
