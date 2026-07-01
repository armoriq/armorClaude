import { createHash } from "node:crypto";
import { isPlainObject } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";
import {
  canonicalPolicyHash,
  evaluatePolicyIr,
  legacyRulesToPolicyIr,
  normalizePolicyIr,
} from "./policy-ir.mjs";

const POLICY_ACTIONS = new Set(["allow", "deny", "require_approval"]);
const POLICY_DATA_CLASSES = new Set(["PCI", "PAYMENT", "PHI", "PII"]);

function normalizeRule(rule) {
  if (!isPlainObject(rule)) {
    return null;
  }
  const id = typeof rule.id === "string" ? rule.id.trim() : "";
  const action = typeof rule.action === "string" ? rule.action.trim() : "";
  const tool = typeof rule.tool === "string" ? rule.tool.trim() : "";
  if (!id || !tool || !POLICY_ACTIONS.has(action)) {
    return null;
  }
  const normalized = {
    id,
    action,
    tool,
  };
  if (typeof rule.dataClass === "string" && POLICY_DATA_CLASSES.has(rule.dataClass.trim())) {
    normalized.dataClass = rule.dataClass.trim();
  }
  if (isPlainObject(rule.params)) {
    normalized.params = rule.params;
  }
  return normalized;
}

function normalizePolicy(policyLike) {
  const input = isPlainObject(policyLike) ? policyLike : {};
  let policy;
  if (input.schemaVersion === "armor.policy.v1") {
    policy = normalizePolicyIr(input);
  } else {
    const rulesInput = Array.isArray(input.rules) ? input.rules : [];
    const rules = rulesInput.map((rule) => normalizeRule(rule)).filter(Boolean);
    policy = legacyRulesToPolicyIr(rules, {}, { decision: "allow" });
  }
  return policy;
}

export async function loadPolicyState(policyFilePath) {
  const initial = {
    version: 0,
    updatedAt: new Date().toISOString(),
    policy: normalizePolicyIr({ statements: [] }),
    history: [],
  };
  const raw = await readJson(policyFilePath, initial);
  const state = isPlainObject(raw) ? raw : initial;
  return {
    version: Number.isFinite(state.version) ? state.version : 0,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date().toISOString(),
    updatedBy: typeof state.updatedBy === "string" ? state.updatedBy : undefined,
    policy: normalizePolicy(state.policy || state),
    history: Array.isArray(state.history) ? state.history : [],
  };
}

export async function savePolicyState(policyFilePath, state) {
  const policy = normalizePolicy(state.policy || state);
  await writeJson(policyFilePath, { ...state, policy });
}

export function computePolicyHash(policy) {
  if (isPlainObject(policy) && policy.schemaVersion === "armor.policy.v1") {
    return canonicalPolicyHash(policy);
  }
  return createHash("sha256")
    .update(JSON.stringify(normalizePolicy(policy)))
    .digest("hex");
}

function extractStrings(value, depth, texts, keys) {
  if (depth > 4) {
    return;
  }
  if (typeof value === "string") {
    texts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => extractStrings(entry, depth + 1, texts, keys));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      extractStrings(entry, depth + 1, texts, keys);
    }
  }
}

function luhnCheck(value) {
  let sum = 0;
  let doubleDigit = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let digit = Number.parseInt(value[i] || "", 10);
    if (!Number.isFinite(digit)) {
      return false;
    }
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function hasCardNumber(texts) {
  const regex = /\b(?:\d[ -]*?){13,19}\b/g;
  for (const text of texts) {
    const matches = text.match(regex);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      const digits = match.replace(/[^\d]/g, "");
      if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
        return true;
      }
    }
  }
  return false;
}

function hasPaymentKeywords(texts, keys) {
  const keywords = ["card", "credit", "payment", "cvv", "iban", "swift", "bank", "routing"];
  const haystack = [...texts, ...keys].join(" ").toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword));
}

function isPaymentTool(toolName) {
  return /pay|payment|transfer|charge|crypto|bank|card|stripe|billing/i.test(toolName);
}

export function detectDataClasses(toolName, toolParams) {
  const texts = [];
  const keys = [];
  extractStrings(toolParams || {}, 0, texts, keys);
  const classes = new Set();
  if (hasCardNumber(texts) || hasPaymentKeywords(texts, keys)) {
    classes.add("PCI");
  }
  if (isPaymentTool(toolName) || hasPaymentKeywords(texts, keys)) {
    classes.add("PAYMENT");
  }
  return classes;
}

export function evaluatePolicy({ policy, toolName, toolParams }) {
  const normalizedPolicy = normalizePolicy(policy);
  const dataClasses = detectDataClasses(toolName, toolParams);
  const decision = evaluatePolicyIr({ policy: normalizedPolicy, toolName, toolParams });
  return { ...decision, dataClasses: Array.from(dataClasses) };
}
