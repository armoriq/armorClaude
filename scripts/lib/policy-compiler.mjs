import { normalizePolicyIr, policyIrToLegacyRules } from "./policy-ir.mjs";

/**
 * ArmorClaude rules → OPA input mapper.
 * Subset of conmap-auto/src/policies/compiler/opa-target-compiler.ts logic.
 *
 * Converts ArmorClaude policy rules into the OPA input format expected
 * by armoriq-opa/bundles/armoriq/armoriq.rego.
 */

export function compileToOpaInput(rules, toolName, toolParams) {
  const legacyRules = Array.isArray(rules) ? rules : policyIrToLegacyRules(normalizePolicyIr(rules));
  const policies = legacyRules.map((rule, idx) => ({
    policyId: rule.id,
    policyName: rule.id,
    priority: idx + 1,
    clientRule: {
      allowedTools: rule.tool === "*"
        ? (rule.action === "deny" ? [] : ["*"])
        : (rule.action === "deny" ? [] : [rule.tool]),
      blockedTools: rule.action === "deny" ? [rule.tool] : [],
      enforcementAction: rule.action === "deny" ? "block"
        : rule.action === "require_approval" ? "hold"
        : "allow",
      dataClassRestrictions: rule.dataClass ? [rule.dataClass] : []
    }
  }));

  return {
    policies,
    context: {
      timestamp: new Date().toISOString()
    },
    resource: {
      toolName,
      resourceType: "tool",
      params: toolParams || {}
    },
    subject: {
      source: "armorclaude"
    }
  };
}

export function compilePolicyForBundle(rules) {
  const legacyRules = Array.isArray(rules) ? rules : policyIrToLegacyRules(normalizePolicyIr(rules));
  return {
    rules: legacyRules.map((rule, idx) => ({
      id: rule.id,
      priority: idx + 1,
      action: rule.action,
      tool: rule.tool,
      dataClass: rule.dataClass || null
    })),
    compiledAt: new Date().toISOString(),
    format: "armorclaude-v1"
  };
}

export function compilePolicyIrForOpaData(policy) {
  const ir = normalizePolicyIr(policy);
  return {
    format: "armorclaude-ir-v1",
    schemaVersion: ir.schemaVersion,
    defaults: ir.defaults,
    statements: ir.statements,
    compiledAt: new Date().toISOString()
  };
}

export function compilePolicyForSdkIntent(policy, policyHash = "") {
  const legacyRules = Array.isArray(policy)
    ? policy
    : policyIrToLegacyRules(normalizePolicyIr(policy));
  const allowedTools = [];
  const deniedTools = [];
  for (const rule of legacyRules) {
    if (!rule || typeof rule.tool !== "string" || !rule.tool.trim()) continue;
    if (rule.action === "deny") {
      deniedTools.push(rule.tool);
    } else if (rule.action === "allow" || rule.action === "require_approval") {
      allowedTools.push(rule.tool);
    }
  }
  return {
    // CSRG verifies Merkle paths like /steps/[0]/tool. ArmorClaude has
    // already evaluated the local IR before token minting, so the CSRG token
    // policy should authorize proof verification for the registered plan
    // paths while carrying tool-level allowlists as metadata for backend/proxy
    // policy layers.
    allow: ["*"],
    deny: [],
    allowed_tools: uniqueStrings(allowedTools),
    denied_tools: uniqueStrings(deniedTools),
    metadata: {
      source: "armorclaude",
      schemaVersion: "armor.policy.v1",
      policyHash
    }
  };
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim())));
}
