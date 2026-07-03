import { normalizePolicyIr, validatePolicyIr } from "./policy-ir.mjs";

// Restrictiveness ranks. Merging always keeps the STRICTER choice so combining
// bundles can never make the resulting policy more permissive than any input.
const DEFAULT_RANK = { allow: 0, hold: 1, deny: 2 };
const EFFECT_RANK = { permit: 0, require_approval: 1, forbid: 2 };

/** Identity of a rule ignoring its effect: same principal+action+resource+conditions. */
function ruleKey(statement) {
  return JSON.stringify([
    statement.principal,
    statement.action,
    statement.resource,
    statement.conditions,
  ]);
}

/**
 * Merge multiple armor.policy.v1 bundles into a single conflict-free policy.
 *
 * Resolution (most-restrictive-wins, safe by construction):
 *  - defaults.decision: strictest across inputs (deny > hold > allow).
 *  - Two rules with the SAME target (principal+action+resource+conditions) but
 *    different effects: keep the strictest effect (forbid > require_approval >
 *    permit). Exact duplicates collapse to one.
 *  - Rules that merely OVERLAP (not identical targets) are all kept; the engine's
 *    deny_overrides conflict resolution settles them safely at evaluation time.
 *  - Statement ids are made unique (collisions get a -N suffix).
 *
 * A single input is returned normalized (a no-op merge). Throws if the merged
 * document fails IR validation.
 */
export function mergePolicies(policies, { name = "custom-merged", description } = {}) {
  const list = Array.isArray(policies) ? policies : [policies];
  if (list.length === 0) {
    throw new Error("mergePolicies requires at least one policy");
  }
  const normalized = list.map((p) => normalizePolicyIr(p));

  // Strictest default wins.
  let decision = "allow";
  for (const p of normalized) {
    if ((DEFAULT_RANK[p.defaults.decision] ?? 0) > (DEFAULT_RANK[decision] ?? 0)) {
      decision = p.defaults.decision;
    }
  }

  // Collapse identical targets, keeping the strictest effect. Insertion order
  // (first-seen) is preserved for deterministic output.
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

  // Unique, stable ids.
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
