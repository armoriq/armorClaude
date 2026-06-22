import { legacyRulesToPolicyIr, normalizePolicyIr } from "./policy-ir.mjs";

/**
 * ArmorClaude IR -> OPA input mapper.
 *
 * OPA receives canonical statements plus a compatibility clientRule envelope
 * for existing rego bundles that still read allowedTools/blockedTools. The
 * source data remains the IR statement.
 */

function policyFromInput(policy) {
  return Array.isArray(policy) ? legacyRulesToPolicyIr(policy) : normalizePolicyIr(policy);
}

function actionValues(action) {
  if (typeof action?.eq === "string") return [action.eq];
  if (Array.isArray(action?.in)) return action.in.filter((entry) => typeof entry === "string");
  return ["*"];
}

function legacyAction(effect) {
  if (effect === "forbid") return "block";
  if (effect === "require_approval") return "hold";
  return "allow";
}

function clientRuleForStatement(statement) {
  const tools = actionValues(statement.action);
  const blockedTools = statement.effect === "forbid" ? tools : [];
  const allowedTools = statement.effect === "forbid" ? [] : tools;
  return {
    allowedTools,
    blockedTools,
    enforcementAction: legacyAction(statement.effect),
    conditions: statement.conditions,
    resource: statement.resource,
  };
}

export function compileToOpaInput(policy, toolName, toolParams) {
  const ir = policyFromInput(policy);
  const policies = ir.statements.map((statement, idx) => ({
    policyId: statement.id,
    policyName: statement.id,
    priority: idx + 1,
    statement,
    clientRule: clientRuleForStatement(statement),
  }));

  return {
    policies,
    policy: {
      schemaVersion: ir.schemaVersion,
      defaults: ir.defaults,
      statements: ir.statements,
    },
    context: {
      timestamp: new Date().toISOString(),
    },
    resource: {
      toolName,
      resourceType: "tool",
      params: toolParams || {},
    },
    subject: {
      source: "armorclaude",
    },
  };
}

export function compilePolicyForBundle(policy) {
  const ir = policyFromInput(policy);
  return {
    format: "armorclaude-ir-v1",
    schemaVersion: ir.schemaVersion,
    defaults: ir.defaults,
    statements: ir.statements,
    compiledAt: new Date().toISOString(),
  };
}

export function compilePolicyIrForOpaData(policy) {
  return compilePolicyForBundle(policy);
}

export function compilePolicyForSdkIntent(policy, policyHash = "") {
  const ir = policyFromInput(policy);
  const allowedTools = [];
  const deniedTools = [];
  for (const statement of ir.statements) {
    const values = actionValues(statement.action);
    if (statement.effect === "forbid") {
      deniedTools.push(...values);
    } else if (statement.effect === "permit" || statement.effect === "require_approval") {
      allowedTools.push(...values);
    }
  }
  return {
    // CSRG verifies Merkle paths like /steps/[0]/tool. ArmorClaude has
    // already evaluated the local IR before token minting, so the CSRG token
    // policy should authorize proof verification for the registered plan
    // paths while carrying statement-level metadata for backend/proxy layers.
    allow: ["*"],
    deny: [],
    allowed_tools: uniqueStrings(allowedTools),
    denied_tools: uniqueStrings(deniedTools),
    statements: ir.statements,
    metadata: {
      source: "armorclaude",
      schemaVersion: ir.schemaVersion,
      policyHash,
    },
  };
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim())));
}
