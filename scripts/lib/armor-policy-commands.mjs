import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isPlainObject } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";
import { loadPolicyState, savePolicyState } from "./policy.mjs";
import {
  canonicalPolicyHash,
  legacyRulesToPolicyIr,
  normalizePolicyIr,
  policyIrToLegacyRules,
  validatePolicyIr
} from "./policy-ir.mjs";
import { getTemplate, getTemplateNames } from "./policy-templates.mjs";
import { listProfiles, loadProfile, saveProfile, deleteProfile } from "./policy-profiles.mjs";
import { listMcpServers, setMcpServerStatus } from "./tool-registry.mjs";
import { loadRuntimeState, saveRuntimeState } from "./runtime-state.mjs";
import { pushProfile as pushProfileToBackend, pullProfiles as pullProfilesFromBackend, syncPolicy as syncPolicyToBackend } from "./backend-client.mjs";

const PENDING_FILE = "policy-pending.json";
const DRAFTS_FILE = "policy-drafts.json";
const PROPOSAL_TTL_MS = 30 * 60 * 1000;

function pendingPath(config) {
  return path.join(config.dataDir, PENDING_FILE);
}

function draftsPath(config) {
  return path.join(config.dataDir, DRAFTS_FILE);
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function proposalId() {
  return `pol_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function formatRule(rule) {
  const parts = [`${rule.id}: ${rule.action} ${rule.tool}`];
  if (rule.dataClass) parts.push(`(${rule.dataClass})`);
  return parts.join(" ");
}

function formatRulesList(rules, label) {
  if (!rules.length) return `${label}: (empty)`;
  const lines = rules.map((r, i) => `  ${i + 1}. ${formatRule(r)}`);
  return `${label} (${rules.length}):\n${lines.join("\n")}`;
}

function diffRules(current, proposed) {
  const currentIds = new Set(current.map(r => r.id));
  const proposedIds = new Set(proposed.map(r => r.id));
  const added = proposed.filter(r => !currentIds.has(r.id));
  const removed = current.filter(r => !proposedIds.has(r.id));
  const kept = proposed.filter(r => currentIds.has(r.id));
  return { added, removed, kept };
}

function formatDiff(current, proposed) {
  const { added, removed } = diffRules(current, proposed);
  const lines = [];
  for (const r of removed) lines.push(`- ${formatRule(r)}`);
  for (const r of added) lines.push(`+ ${formatRule(r)}`);
  if (!lines.length) lines.push("(no changes)");
  return lines.join("\n");
}

function summarizeRules(rules, prefix = "+") {
  return rules.map((rule) => `${prefix} ${rule.action === "deny" ? "forbid" : rule.action === "allow" ? "permit" : "require approval"} tool ${rule.tool}`);
}

function jsonPatchForRules(currentRules, proposedRules) {
  const currentIds = new Set(currentRules.map((rule) => rule.id));
  const proposedIds = new Set(proposedRules.map((rule) => rule.id));
  const patch = [];
  for (const rule of currentRules) {
    if (!proposedIds.has(rule.id)) patch.push({ op: "remove", path: `/rules/${rule.id}` });
  }
  for (const rule of proposedRules) {
    if (!currentIds.has(rule.id)) patch.push({ op: "add", path: "/statements/-", value: rule });
  }
  return patch;
}

function formatProposal(pending, currentRules, proposedRules, title = "Proposed policy change:") {
  const { added, removed } = diffRules(currentRules, proposedRules);
  return [
    title,
    pending.source?.type ? `Source: ${pending.source.type}` : "",
    `Proposal: ${pending.proposalId}`,
    `Base policy: v${pending.baseVersion}`,
    "",
    "Changes:",
    ...summarizeRules(added, "+"),
    ...summarizeRules(removed, "-"),
    added.length || removed.length ? "" : "(no changes)",
    "",
    "Patch:",
    JSON.stringify(pending.patch || jsonPatchForRules(currentRules, proposedRules), null, 2),
    "",
    "Legacy diff:",
    formatDiff(currentRules, proposedRules),
    "",
    "JSON proposal:",
    JSON.stringify({
      proposalId: pending.proposalId,
      baseVersion: pending.baseVersion,
      proposalHash: pending.proposalHash,
      expiresAt: pending.expiresAt,
      policy: pending.proposedPolicy,
      proposedRules
    }, null, 2),
    "",
    formatRulesList(proposedRules, "Proposed rules"),
    "",
    `Type /armor policy confirm ${pending.proposalId} to apply, or /armor policy cancel ${pending.proposalId} to discard.`
  ].join("\n");
}

function formatDraft(draft) {
  return [
    "Drafted from natural language. Not staged.",
    "",
    `Draft: ${draft.draftId}`,
    "",
    "Ambiguities:",
    ...draft.ambiguities.map((entry) => `- ${entry}`),
    "",
    "Normalized JSON:",
    JSON.stringify(draft.policy, null, 2),
    "",
    "Next:",
    `  /armor policy stage ${draft.draftId}`,
    `  /armor policy revise ${draft.draftId} "clarify what should change"`
  ].join("\n");
}

function formatDraftRevision({ original, revised, removedIds, note }) {
  const beforeRules = policyIrToLegacyRules(original.policy);
  const afterRules = policyIrToLegacyRules(revised.policy);
  return [
    "Draft revised. Not staged.",
    "",
    `Previous draft: ${original.draftId}`,
    `New draft: ${revised.draftId}`,
    note ? `Note: ${note}` : "",
    removedIds.length ? `Removed statements: ${removedIds.join(", ")}` : "",
    "",
    "Changes:",
    formatDiff(beforeRules, afterRules),
    "",
    "Normalized JSON:",
    JSON.stringify(revised.policy, null, 2),
    "",
    "Next:",
    `  /armor policy stage ${revised.draftId}`,
    `  /armor policy revise ${revised.draftId} "clarify what should change"`
  ].filter((line) => line !== "").join("\n");
}

function nextPolicyId(rules) {
  const ids = rules
    .map(r => r.id.match(/^policy(\d+)$/i))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  return `policy${(ids.length ? Math.max(...ids) : 0) + 1}`;
}

function policyFromRules(rules, state, name = "current") {
  const currentDefault = state?.policy?.defaults?.decision || "deny";
  return legacyRulesToPolicyIr(
    rules,
    {
      name: state?.policy?.metadata?.name || name,
      description: state?.policy?.metadata?.description || ""
    },
    { decision: currentDefault }
  );
}

function draftId() {
  return `draft_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function extractJson(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function saveDraft(config, draft) {
  const state = await readJson(draftsPath(config), { drafts: {} });
  const drafts = isPlainObject(state?.drafts) ? state.drafts : {};
  drafts[draft.draftId] = draft;
  await writeJson(draftsPath(config), { drafts });
  return draft;
}

async function loadDraft(config, id) {
  const state = await readJson(draftsPath(config), { drafts: {} });
  return state?.drafts?.[id] || null;
}

function reviseDraftPolicy(draft, instruction) {
  const raw = typeof instruction === "string" ? instruction.trim() : "";
  const lower = raw.toLowerCase();
  const policy = normalizePolicyIr(draft.policy);
  const removedIds = [];
  let statements = policy.statements;

  const removeMatch = raw.match(/\b(?:remove|delete|drop)\b\s+(?:the\s+)?([a-z0-9_-]+)(?:\s+(?:id|statement|rule))?/i);
  if (removeMatch) {
    const requested = removeMatch[1].toLowerCase();
    const before = statements.length;
    statements = statements.filter((statement) => {
      const statementId = statement.id.toLowerCase();
      const shouldRemove =
        statementId === requested ||
        statementId.includes(requested) ||
        requested.includes(statementId);
      if (shouldRemove) removedIds.push(statement.id);
      return !shouldRemove;
    });
    if (before === statements.length) {
      return { ok: false, error: `No draft statement matched "${removeMatch[1]}".` };
    }
  } else if (/\ballow\s+explore\b/i.test(raw)) {
    statements = [
      ...statements,
      {
        id: "allow-explore",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Explore" },
        resource: { type: "workspace", scope: "current" },
        conditions: []
      }
    ];
  } else if (/\ballow\s+skill\b/i.test(raw)) {
    statements = [
      ...statements,
      {
        id: "allow-skill",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Skill" },
        resource: { type: "workspace", scope: "current" },
        conditions: []
      }
    ];
  } else if (/\bdefault\s+allow\b|\ballow\s+by\s+default\b/i.test(raw)) {
    policy.defaults.decision = "allow";
  } else if (/\bdefault\s+deny\b|\bdeny\s+by\s+default\b/i.test(raw)) {
    policy.defaults.decision = "deny";
  } else {
    return {
      ok: false,
      error: [
        "Could not revise that draft deterministically.",
        "Supported revise examples:",
        `  /armor policy revise ${draft.draftId} "remove forbid-cloud-db-admin"`,
        `  /armor policy revise ${draft.draftId} "allow Explore"`,
        `  /armor policy revise ${draft.draftId} "default allow"`
      ].join("\n")
    };
  }

  const revisedPolicy = normalizePolicyIr({
    ...policy,
    metadata: {
      ...policy.metadata,
      description: `${policy.metadata.description || ""}\nRevision: ${raw}`.trim()
    },
    statements
  });
  const result = validatePolicyIr(revisedPolicy);
  if (!result.ok) return { ok: false, error: `Revised draft failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}` };
  return {
    ok: true,
    removedIds,
    policy: result.policy
  };
}

function inferComplexDraft(raw, state) {
  const lower = raw.toLowerCase();
  const name =
    raw.match(/save\s+(?:this\s+)?as\s+([a-z0-9_-]+)/i)?.[1] ||
    raw.match(/name\s+(?:the\s+)?policy\s+([a-z0-9_-]+)/i)?.[1] ||
    "draft-policy";
  const wantsWriteTools = /\b(write|edit|modify|change|create files?|update files?)\b/i.test(raw);
  const broadBashExceptDenied =
    /\b(other things using bash|use other things using bash|bash but not|except|not these|anything else using bash)\b/i.test(raw) ||
    (/\bdo not allow\b/i.test(raw) && /\bbash\b/i.test(raw) && /\b(psql|gcloud|kubectl|aws|az)\b/i.test(raw));
  const allowAllBash =
    /\ballow\s+all\s+bash\b/i.test(raw) ||
    /\bbash\s+tool\s+is\s+allowed\s+for\s+all\b/i.test(raw) ||
    /\bbash\b[\s\S]*\b(any|all)\s+commands?\b/i.test(raw);
  const removeExplicitForbid =
    /\b(remove|delete|drop)\b[\s\S]*\bforbid\b/i.test(raw) ||
    /\bremove\b[\s\S]*\bcloud\b[\s\S]*\bdb\b[\s\S]*\badmin\b/i.test(raw);
  const programs = [];
  for (const [needle, program] of [
    ["ls", "ls"],
    ["curl", "curl"],
    ["grep", "grep"],
    ["cat", "cat"],
    ["find", "find"],
    ["port", "lsof"],
    ["port", "netstat"],
    ["port", "ss"]
  ]) {
    if (lower.includes(needle) && !programs.includes(program)) programs.push(program);
  }
  const denied = [];
  for (const program of ["psql", "gcloud", "kubectl", "aws", "az"]) {
    if (lower.includes(program)) denied.push(program);
  }
  const fileTools = wantsWriteTools
    ? ["Read", "Grep", "Glob", "Write", "Edit", "MultiEdit"]
    : ["Read", "Grep", "Glob"];
  const statements = [
    {
      id: wantsWriteTools ? "allow-file-tools" : "allow-read-tools",
      effect: "permit",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", in: fileTools },
      resource: { type: "workspace", scope: "current" },
      conditions: []
    }
  ];
  if (allowAllBash) {
    statements.push({
      id: "allow-all-bash",
      effect: "permit",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: []
    });
  } else if (broadBashExceptDenied && denied.length) {
    statements.push({
      id: "allow-bash-except-denied-programs",
      effect: "permit",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [{ field: "bash.program", op: "not_in", value: denied }]
    });
  } else if (programs.length) {
    statements.push({
      id: "allow-safe-bash-inspection",
      effect: "permit",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [
        { field: "bash.program", op: "in", value: programs },
        { field: "bash.hasWriteRedirection", op: "eq", value: false }
      ]
    });
  }
  if (denied.length && !removeExplicitForbid && !allowAllBash) {
    statements.push({
      id: "forbid-cloud-db-admin",
      effect: "forbid",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [{ field: "bash.program", op: "in", value: denied }]
    });
  }
  const policy = normalizePolicyIr({
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name, description: `Drafted from: ${raw}` },
    defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    statements
  });
  const ambiguities = [];
  if (allowAllBash) {
    ambiguities.push("All Bash commands are allowed. This is powerful and should only be staged for trusted workspaces.");
  }
  if (broadBashExceptDenied && denied.length) {
    ambiguities.push(`Bash is broadly allowed except ${denied.join(", ")}. Review carefully before staging.`);
  }
  if (removeExplicitForbid && denied.length) {
    ambiguities.push("Explicit forbid statement was omitted because the prompt asked to remove it; denied programs are only excluded from the Bash allow condition.");
  }
  if (wantsWriteTools) {
    ambiguities.push("Write/Edit/MultiEdit are included because the prompt mentioned writing or editing files.");
  }
  if (lower.includes("curl")) ambiguities.push("curl can access external network. Scope all URLs or selected domains?");
  if (lower.includes("port")) ambiguities.push("port checks could mean lsof, netstat, ss, nc, or nmap. This draft permits lsof/netstat/ss only.");
  if (lower.includes("file")) ambiguities.push("file access could mean read-only or write access. This draft allows read-oriented tools only.");
  if (!ambiguities.length) ambiguities.push("This was too complex for deterministic staging; review the normalized JSON before staging.");
  return {
    draftId: draftId(),
    createdAt: new Date().toISOString(),
    source: { type: "llm_or_complex_nl_draft", input: raw },
    policy,
    ambiguities,
    policyHash: canonicalPolicyHash(policy)
  };
}

function canonicalCommandText(prompt) {
  const trimmed = typeof prompt === "string" ? prompt.trim() : "";
  if (!trimmed) return null;

  let match = trimmed.match(/^\/armor-policy\b\s*(.*)$/i);
  if (match) return { rest: (match[1] || "").trim(), alias: "/armor-policy" };

  match = trimmed.match(/^\/armorclaude:armor-policy\b\s*(.*)$/i);
  if (match) return { rest: (match[1] || "").trim(), alias: "/armorclaude:armor-policy" };

  match = trimmed.match(/^\/armor\b\s*(.*)$/i);
  if (!match) return null;
  let rest = (match[1] || "").trim();
  if (/^policy\b/i.test(rest)) {
    rest = rest.replace(/^policy\b\s*/i, "").trim();
  }
  return { rest, alias: "/armor" };
}

function parseCommand(prompt) {
  const canonical = canonicalCommandText(prompt);
  if (!canonical) return null;

  const rest = canonical.rest;
  const lower = rest.toLowerCase();

  if (!rest || lower === "help") return { cmd: "help" };
  if (lower === "list") return { cmd: "list" };
  if (lower === "reset") return { cmd: "reset" };
  if (lower === "export") return { cmd: "export" };

  const stageMatch = rest.match(/^stage\s+([\s\S]+)$/i);
  if (stageMatch) return { cmd: "stage", value: stageMatch[1].trim() };

  const draftValidateMatch = rest.match(/^draft\s+validate\s+([\s\S]+)$/i);
  if (draftValidateMatch) return { cmd: "draft-validate", value: draftValidateMatch[1].trim() };

  const draftEditMatch = rest.match(/^draft\s+edit\s+(draft_[A-Za-z0-9_-]+)\s+([\s\S]+)$/i);
  if (draftEditMatch) return { cmd: "draft-edit", draftId: draftEditMatch[1], value: draftEditMatch[2].trim() };

  const reviseMatch = rest.match(/^revise\s+(draft_[A-Za-z0-9_-]+)\s+([\s\S]+)$/i);
  if (reviseMatch) return { cmd: "revise", draftId: reviseMatch[1], instruction: reviseMatch[2].trim() };

  const confirmMatch = rest.match(/^confirm(?:\s+(\S+))?(?:\s+save\s+(\S+))?$/i);
  if (confirmMatch) {
    return { cmd: "confirm", proposalId: confirmMatch[1] || "", saveAs: confirmMatch[2] || "" };
  }

  const cancelMatch = rest.match(/^cancel(?:\s+(\S+))?$/i);
  if (cancelMatch) return { cmd: "cancel", proposalId: cancelMatch[1] || "" };

  const addMatch = rest.match(/^add\s+(allow|deny|hold|require_approval)\s+(.+)/i);
  if (addMatch) {
    if (looksComplexNaturalLanguage(rest)) return { cmd: "draft-complex", raw: rest };
    const action = addMatch[1].toLowerCase() === "hold" ? "require_approval" : addMatch[1].toLowerCase();
    const rules = parseNaturalRules(rest);
    if (rules.length > 1) return { cmd: "add-many", rules, raw: rest };
    return { cmd: "add", action, tool: addMatch[2].trim() };
  }
  if (lower.startsWith("add ")) {
    if (looksComplexNaturalLanguage(rest)) return { cmd: "draft-complex", raw: rest };
    const rules = parseNaturalRules(rest);
    if (rules.length > 0) return { cmd: "add-many", rules, raw: rest };
    return { cmd: "parse-error", raw: rest };
  }

  const removeMatch = rest.match(/^remove\s+(\S+)/i);
  if (removeMatch) return { cmd: "remove", id: removeMatch[1] };

  const templateMatch = rest.match(/^template\s+(\S+)/i);
  if (templateMatch) return { cmd: "template", name: templateMatch[1] };

  if (lower.startsWith("mcp ")) return parseMcpCommand(rest.slice(4).trim());
  if (lower.startsWith("profile ")) return parseProfileCommand(rest.slice(8).trim());
  if (lower.startsWith("settings")) return { cmd: "settings", rest: rest.slice(8).trim() };
  if (lower === "sync") return { cmd: "sync" };

  return { cmd: "help" };
}

function parseMcpCommand(rest) {
  const lower = rest.toLowerCase();
  if (!rest || lower === "list") return { cmd: "mcp-list" };
  const approveMatch = rest.match(/^approve\s+(\S+)/i);
  if (approveMatch) return { cmd: "mcp-approve", server: approveMatch[1] };
  const denyMatch = rest.match(/^deny\s+(\S+)/i);
  if (denyMatch) return { cmd: "mcp-deny", server: denyMatch[1] };
  return { cmd: "help" };
}

function parseProfileCommand(rest) {
  const lower = rest.toLowerCase();
  if (!rest || lower === "list") return { cmd: "profile-list" };
  const saveMatch = rest.match(/^save\s+(\S+)/i);
  if (saveMatch) return { cmd: "profile-save", name: saveMatch[1] };
  const switchMatch = rest.match(/^switch\s+(\S+)/i);
  if (switchMatch) return { cmd: "profile-switch", name: switchMatch[1] };
  const deleteMatch = rest.match(/^delete\s+(\S+)/i);
  if (deleteMatch) return { cmd: "profile-delete", name: deleteMatch[1] };
  const pushMatch = rest.match(/^push\s+(\S+)/i);
  if (pushMatch) return { cmd: "profile-push", name: pushMatch[1] };
  if (lower === "pull") return { cmd: "profile-pull" };
  return { cmd: "help" };
}

function normalizeAction(raw) {
  const value = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (value === "allow") return "allow";
  if (value === "deny" || value === "block") return "deny";
  if (["hold", "require_approval", "require approval", "ask before"].includes(value)) {
    return "require_approval";
  }
  return "";
}

function normalizeToolLabel(raw) {
  const cleaned = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(the|a|an)\s+/i, "")
    .replace(/\s+tool$/i, "")
    .trim();
  const aliases = new Map([
    ["bash", "Bash"],
    ["shell", "Bash"],
    ["terminal", "Bash"],
    ["read", "Read"],
    ["grep", "Grep"],
    ["glob", "Glob"],
    ["edit", "Edit"],
    ["write", "Write"],
    ["webfetch", "WebFetch"],
    ["web fetch", "WebFetch"],
    ["websearch", "WebSearch"],
    ["web search", "WebSearch"]
  ]);
  return aliases.get(cleaned.toLowerCase()) || cleaned;
}

function splitToolList(rawTools) {
  return rawTools
    .replace(/\b(to use|using|for|tools?|commands?)\b/gi, " ")
    .split(/\s*(?:,|\band\b|\&|\+)\s*/i)
    .map(normalizeToolLabel)
    .filter(Boolean);
}

function looksComplexNaturalLanguage(text) {
  const lower = text.toLowerCase();
  return /["']|only allow|should|policy should|save (this )?as|port access|file access|curl|psql|gcloud/.test(lower) &&
    !/^add\s+(allow|deny|hold|require_approval)\s+[\w\s,|&+*-]+$/i.test(text);
}

export function parseNaturalRules(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return [];
  const body = raw.replace(/^add\b/i, "").trim();
  const actionPattern = "(?:allow|deny|block|hold|require_approval|require\\s+approval|ask\\s+before)";
  const regex = new RegExp(`\\b(${actionPattern})\\b\\s+([\\s\\S]*?)(?=\\s*(?:[,;]\\s*)?\\b${actionPattern}\\b\\s+|$)`, "gi");
  const rules = [];
  for (const match of body.matchAll(regex)) {
    const action = normalizeAction(match[1]);
    const tools = splitToolList(match[2] || "");
    for (const tool of tools) {
      if (action && tool) rules.push({ action, tool });
    }
  }
  return rules;
}

function helpText() {
  return [
    "ArmorClaude Policy Commands:",
    "",
    "  /armor                              — show this help",
    "  /armor policy list                  — show current rules",
    "  /armor policy add allow Read and Grep, deny Write, hold Bash",
    "  /armor policy stage <draft-id|json> — stage validated draft or JSON",
    "  /armor policy revise <draft-id> \"remove <statement-id>\"",
    "  /armor policy draft edit <draft-id> <json> — replace draft JSON after validation",
    "  /armor policy draft validate <json> — validate pasted policy JSON as a new draft",
    "  /armor policy remove <rule-id>       — propose removing a rule",
    "  /armor policy reset                  — propose clearing all rules",
    "  /armor policy template <name>        — propose applying a template",
    "  /armor policy confirm [proposal-id]  — apply staged change",
    "  /armor policy cancel [proposal-id]   — discard staged change",
    "  /armor policy export                 — dump policy as JSON",
    "",
    "  /armor mcp list                     — show detected MCPs",
    "  /armor mcp approve <server>         — approve an MCP server",
    "  /armor mcp deny <server>            — deny an MCP server",
    "",
    "  /armor profile save <name>          — save current policy as profile",
    "  /armor profile list                 — show saved profiles",
    "  /armor profile switch <name>        — switch to a saved profile",
    "  /armor profile delete <name>        — delete a profile",
    "",
    "  Legacy alias: /armor-policy ...",
    `  Templates: ${getTemplateNames().join(", ")}`,
  ].join("\n");
}

export function isArmorPolicyCommand(prompt) {
  return Boolean(canonicalCommandText(prompt));
}

export async function handleArmorPolicyCommand(prompt, config) {
  const parsed = parseCommand(prompt);
  if (!parsed) return null;

  switch (parsed.cmd) {
    case "help":
      return helpText();

    case "parse-error":
      return [
        "Could not parse that policy request, so no policy was staged.",
        "Try: /armor policy add allow Read and Grep, deny Write, hold Bash"
      ].join("\n");

    case "draft-complex": {
      const state = await loadPolicyState(config.policyFile);
      const draft = await saveDraft(config, inferComplexDraft(parsed.raw, state));
      return formatDraft(draft);
    }

    case "draft-validate": {
      const parsedJson = extractJson(parsed.value);
      if (!parsedJson) return "Draft validation failed: input is not valid JSON.";
      const result = validatePolicyIr(parsedJson);
      if (!result.ok) {
        return `Draft validation failed:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
      }
      const draft = await saveDraft(config, {
        draftId: draftId(),
        createdAt: new Date().toISOString(),
        source: { type: "llm_draft", input: "pasted-json" },
        policy: result.policy,
        ambiguities: ["LLM/pasted draft validated structurally. Review intent before staging."],
        policyHash: canonicalPolicyHash(result.policy)
      });
      return formatDraft(draft);
    }

    case "draft-edit": {
      const existing = await loadDraft(config, parsed.draftId);
      if (!existing) return `Draft not found: ${parsed.draftId}`;
      const parsedJson = extractJson(parsed.value);
      if (!parsedJson) return "Draft edit failed: replacement is not valid JSON.";
      const result = validatePolicyIr(parsedJson);
      if (!result.ok) {
        return `Draft edit failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
      }
      const draft = await saveDraft(config, {
        draftId: draftId(),
        createdAt: new Date().toISOString(),
        source: {
          type: "manual_json_draft_edit",
          input: "pasted-json",
          previousDraftId: existing.draftId
        },
        policy: result.policy,
        ambiguities: ["Manual JSON edit validated structurally. Review intent before staging."],
        policyHash: canonicalPolicyHash(result.policy)
      });
      return formatDraftRevision({
        original: existing,
        revised: draft,
        removedIds: [],
        note: "Manual JSON replacement validated. No active policy changed."
      });
    }

    case "revise": {
      const existing = await loadDraft(config, parsed.draftId);
      if (!existing) return `Draft not found: ${parsed.draftId}`;
      const revised = reviseDraftPolicy(existing, parsed.instruction);
      if (!revised.ok) return revised.error;
      const draft = await saveDraft(config, {
        draftId: draftId(),
        createdAt: new Date().toISOString(),
        source: {
          type: "deterministic_draft_revision",
          input: parsed.instruction,
          previousDraftId: existing.draftId
        },
        policy: revised.policy,
        ambiguities: [
          "Draft was revised deterministically. Review the normalized JSON before staging."
        ],
        policyHash: canonicalPolicyHash(revised.policy)
      });
      return formatDraftRevision({
        original: existing,
        revised: draft,
        removedIds: revised.removedIds || [],
        note: "No active policy changed."
      });
    }

    case "stage": {
      const state = await loadPolicyState(config.policyFile);
      let policy = null;
      let draft = null;
      if (/^draft_[a-f0-9]{8}$/i.test(parsed.value)) {
        draft = await loadDraft(config, parsed.value);
        if (!draft) return `Draft not found: ${parsed.value}`;
        policy = draft.policy;
      } else {
        const parsedJson = extractJson(parsed.value);
        if (!parsedJson) return "Stage failed: provide a draft id or valid policy JSON.";
        const result = validatePolicyIr(parsedJson);
        if (!result.ok) {
          return `Stage failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
        }
        policy = result.policy;
      }
      const proposedRules = policyIrToLegacyRules(policy);
      const pending = await stagePending(config, state, state.policy.rules, proposedRules, `stage ${draft?.draftId || "pasted policy"}`, policy, {
        type: draft ? "llm_draft_stage" : "pasted_json_stage"
      });
      return formatProposal(pending, state.policy.rules, proposedRules, "Staged validated policy draft:");
    }

    case "list": {
      const state = await loadPolicyState(config.policyFile);
      if (!state.policy.rules.length) {
        return `Policy v${state.version}: no rules configured.\nUse /armor policy add or /armor policy template to get started.`;
      }
      return `Policy v${state.version}:\n${state.policy.rules.map((r, i) => `  ${i + 1}. ${formatRule(r)}`).join("\n")}`;
    }

    case "export": {
      const state = await loadPolicyState(config.policyFile);
      return JSON.stringify(state, null, 2);
    }

    case "add": {
      const state = await loadPolicyState(config.policyFile);
      const id = nextPolicyId(state.policy.rules);
      const newRule = { id, action: parsed.action, tool: parsed.tool };
      const proposedRules = [...state.policy.rules, newRule];
      const proposedPolicy = policyFromRules(proposedRules, state);
      const pending = await stagePending(config, state, state.policy.rules, proposedRules, `add ${parsed.action} ${parsed.tool}`, proposedPolicy, { type: "deterministic" });
      return formatProposal(pending, state.policy.rules, proposedRules);
    }

    case "add-many": {
      const state = await loadPolicyState(config.policyFile);
      let nextRules = [...state.policy.rules];
      for (const rule of parsed.rules) {
        const id = nextPolicyId(nextRules);
        nextRules = [...nextRules, { id, action: rule.action, tool: rule.tool }];
      }
      const proposedPolicy = policyFromRules(nextRules, state);
      const pending = await stagePending(config, state, state.policy.rules, nextRules, parsed.raw, proposedPolicy, { type: "deterministic" });
      return formatProposal(pending, state.policy.rules, nextRules, "Proposed policy changes:");
    }

    case "remove": {
      const state = await loadPolicyState(config.policyFile);
      const exists = state.policy.rules.find(r => r.id === parsed.id);
      if (!exists) return `Rule not found: ${parsed.id}`;
      const proposedRules = state.policy.rules.filter(r => r.id !== parsed.id);
      const proposedPolicy = policyFromRules(proposedRules, state);
      const pending = await stagePending(config, state, state.policy.rules, proposedRules, `remove ${parsed.id}`, proposedPolicy, { type: "deterministic" });
      return formatProposal(pending, state.policy.rules, proposedRules);
    }

    case "reset": {
      const state = await loadPolicyState(config.policyFile);
      const proposedPolicy = policyFromRules([], state);
      const pending = await stagePending(config, state, state.policy.rules, [], "reset all rules", proposedPolicy, { type: "deterministic" });
      return [
        "Proposed: clear ALL policy rules.",
        formatDiff(state.policy.rules, []),
        "",
        `Type /armor policy confirm ${pending.proposalId} to apply, or /armor policy cancel ${pending.proposalId} to discard.`
      ].join("\n");
    }

    case "template": {
      const tmpl = getTemplate(parsed.name);
      if (!tmpl) {
        return `Unknown template: ${parsed.name}\nAvailable: ${getTemplateNames().join(", ")}`;
      }
      const state = await loadPolicyState(config.policyFile);
      const proposedPolicy = policyFromRules(tmpl.rules, state);
      const pending = await stagePending(config, state, state.policy.rules, tmpl.rules, `template ${parsed.name}`, proposedPolicy, { type: "deterministic" });
      return formatProposal(pending, state.policy.rules, tmpl.rules, `Proposed: apply template "${tmpl.name}" — ${tmpl.description}`);
    }

    case "confirm": {
      const pending = await readJson(pendingPath(config), null);
      if (!pending) return "Nothing staged. Use /armor policy add, remove, reset, or template first.";
      const state = await loadPolicyState(config.policyFile);
      if (pending.proposalId && parsed.proposalId && parsed.proposalId !== pending.proposalId) {
        return `Proposal not found: ${parsed.proposalId}. Current staged proposal is ${pending.proposalId}.`;
      }
      if (pending.expiresAt && Date.now() > Date.parse(pending.expiresAt)) {
        await clearPending(config);
        return "Staged policy proposal expired. Please stage it again.";
      }
      if (Number.isFinite(pending.baseVersion) && pending.baseVersion !== state.version) {
        return `Policy changed since proposal was staged (base v${pending.baseVersion}, current v${state.version}). Please review and stage again.`;
      }
      const currentHashMaterial = pending.proposedPolicy || pending.proposedRules;
      if (
        (pending.proposalHash && pending.proposalHash !== hashJson(currentHashMaterial)) ||
        (pending.proposedRulesHash && pending.proposedRulesHash !== hashJson(pending.proposedRules))
      ) {
        return "Staged policy proposal hash mismatch. Refusing to apply.";
      }
      const nextState = {
        version: state.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: "user",
        policy: pending.proposedPolicy || policyFromRules(pending.proposedRules, state),
        history: [
          ...state.history,
          {
            version: state.version + 1,
            updatedAt: new Date().toISOString(),
            updatedBy: "user",
            reason: pending.reason,
            proposalId: pending.proposalId,
            policy: pending.proposedPolicy || policyFromRules(pending.proposedRules, state)
          }
        ]
      };
      await savePolicyState(config.policyFile, nextState);
      let profileNote = "";
      if (parsed.saveAs) {
        const saved = await saveProfile(config, parsed.saveAs, "", nextState.policy);
        profileNote = ` Profile "${parsed.saveAs}" saved (v${saved.version}).`;
      }
      await clearPending(config);

      // Crypto integrity: issue signed policy token after every confirm
      let cryptoNote = "";
      if (config.cryptoPolicyEnabled) {
        try {
          const { createCryptoPolicyService } = await import("./crypto-policy.mjs");
          const cryptoService = createCryptoPolicyService(config);
          await cryptoService.issuePolicyToken(nextState, {
            userId: config.userId,
            agentId: config.agentId,
            contextId: config.contextId
          });
          cryptoNote = " Crypto policy token issued.";
        } catch {
          cryptoNote = " (crypto token issuance failed — policy still applied)";
        }
      }

      // OPA mode: push compiled bundle to backend
      if (config.enforcementEngine === "opa" && config.apiKey) {
        try {
          const { syncPolicy: syncToBackend } = await import("./backend-client.mjs");
          await syncToBackend(config, nextState);
        } catch {
          // fire-and-forget — local policy is authoritative
        }
      }

      return `Policy updated to v${nextState.version}. ${pending.reason}${profileNote}${cryptoNote}`;
    }

    case "cancel": {
      const pending = await readJson(pendingPath(config), null);
      if (!pending) return "Nothing staged to cancel.";
      if (pending.proposalId && parsed.proposalId && parsed.proposalId !== pending.proposalId) {
        return `Proposal not found: ${parsed.proposalId}. Current staged proposal is ${pending.proposalId}.`;
      }
      await clearPending(config);
      return `Staged policy change${pending.proposalId ? ` ${pending.proposalId}` : ""} discarded.`;
    }

    case "mcp-list": {
      const rtState = await loadRuntimeState(config.runtimeFile);
      const servers = listMcpServers(rtState);
      if (!servers.length) return "No MCP servers detected yet.";
      const lines = servers.map(s =>
        `  ${s.serverName} — ${s.status}`
      );
      return `MCP servers (${servers.length}):\n${lines.join("\n")}`;
    }

    case "mcp-approve": {
      const rtState = await loadRuntimeState(config.runtimeFile);
      setMcpServerStatus(rtState, parsed.server, "approved");
      await saveRuntimeState(config.runtimeFile, rtState);
      return `MCP server "${parsed.server}" approved. Its tools will now be allowed.`;
    }

    case "mcp-deny": {
      const rtState = await loadRuntimeState(config.runtimeFile);
      setMcpServerStatus(rtState, parsed.server, "denied");
      await saveRuntimeState(config.runtimeFile, rtState);
      return `MCP server "${parsed.server}" denied. Its tools will be blocked.`;
    }

    case "profile-list": {
      const profiles = await listProfiles(config);
      if (!profiles.length) return "No profiles found.";
      const lines = profiles.map(p =>
        `  ${p.profile.name} — ${p.profile.description || "(no description)"} (v${p.version}, ${p.profile.createdBy})`
      );
      return `Saved profiles (${profiles.length}):\n${lines.join("\n")}`;
    }

    case "profile-save": {
      const state = await loadPolicyState(config.policyFile);
      if (!state.policy.rules.length) {
        return "Cannot save empty policy as profile. Add rules first.";
      }
      const saved = await saveProfile(config, parsed.name, "", state.policy);
      return `Profile "${parsed.name}" saved (v${saved.version}, ${state.policy.rules.length} rules).`;
    }

    case "profile-switch": {
      const profile = await loadProfile(config, parsed.name);
      if (!profile) {
        const profiles = await listProfiles(config);
        const names = profiles.map(p => p.profile.name).join(", ");
        return `Profile not found: ${parsed.name}\nAvailable: ${names || "(none)"}`;
      }
      const state = await loadPolicyState(config.policyFile);
      const profilePolicy = profile.policy?.schemaVersion
        ? normalizePolicyIr(profile.policy)
        : policyFromRules(profile.policy.rules, state, parsed.name);
      const profileRules = policyIrToLegacyRules(profilePolicy);
      const pending = await stagePending(config, state, state.policy.rules, profileRules, `switch to profile "${parsed.name}"`, profilePolicy, { type: "deterministic" });
      return formatProposal(
        pending,
        state.policy.rules,
        profileRules,
        `Proposed: switch to profile "${profile.profile.name}" — ${profile.profile.description || "(no description)"}`
      );
    }

    case "profile-delete": {
      const deleted = await deleteProfile(config, parsed.name);
      if (!deleted) return `Profile not found: ${parsed.name}`;
      return `Profile "${parsed.name}" deleted.`;
    }

    case "profile-push": {
      if (!config.apiKey) return "Profile push requires an API key. Set ARMORIQ_API_KEY or configure credentials.";
      const profile = await loadProfile(config, parsed.name);
      if (!profile) return `Profile not found: ${parsed.name}`;
      const result = await pushProfileToBackend(config, profile);
      if (!result.ok) return `Failed to push profile "${parsed.name}": ${result.reason || `HTTP ${result.status}`}`;
      return `Profile "${parsed.name}" pushed to organization.`;
    }

    case "profile-pull": {
      if (!config.apiKey) return "Profile pull requires an API key. Set ARMORIQ_API_KEY or configure credentials.";
      const result = await pullProfilesFromBackend(config);
      if (!result.ok) return `Failed to pull profiles: ${result.reason || `HTTP ${result.status}`}`;
      if (!result.profiles.length) return "No org profiles found on backend.";
      let saved = 0;
      for (const p of result.profiles) {
        if (p?.profile?.name && p?.policy?.rules) {
          await saveProfile(config, p.profile.name, p.profile.description || "", p.policy.rules);
          saved++;
        }
      }
      return `Pulled ${saved} profile(s) from organization.`;
    }

    case "settings": {
      const settingsRest = (parsed.rest || "").trim().toLowerCase();
      if (!settingsRest) {
        return [
          "ArmorClaude Settings:",
          `  Enforcement engine: ${config.enforcementEngine || "local"}`,
          `  OPA PDP URL: ${config.opaPdpUrl || "(not set)"}`,
          `  MCP deny-by-default: ${config.mcpDenyByDefault !== false ? "on" : "off"}`,
          "",
          "  /armor settings enforcement <local|opa>  — switch enforcement engine",
        ].join("\n");
      }
      const enfMatch = settingsRest.match(/^enforcement\s+(local|opa)$/);
      if (enfMatch) {
        const engine = enfMatch[1];
        if (engine === "opa" && !config.opaPdpUrl) {
          return "Cannot switch to OPA: ARMORCLAUDE_OPA_PDP_URL is not configured.";
        }
        return `Enforcement engine set to "${engine}". Restart session to apply.\n` +
          `Note: Set ARMORCLAUDE_ENFORCEMENT_ENGINE=${engine} in your environment to persist.`;
      }
      return "Unknown setting. Use: /armor settings enforcement <local|opa>";
    }

    case "sync": {
      if (!config.apiKey) return "Sync requires an API key. Set ARMORIQ_API_KEY or configure credentials.";
      const state = await loadPolicyState(config.policyFile);
      const result = await syncPolicyToBackend(config, state);
      if (!result.ok) return `Sync failed: ${result.reason || `HTTP ${result.status}`}`;
      return `Policy v${state.version} synced to backend.`;
    }

    default:
      return helpText();
  }
}

async function stagePending(config, state, currentRules, proposedRules, reason, proposedPolicy = null, source = { type: "deterministic" }) {
  const policy = proposedPolicy || policyFromRules(proposedRules, state);
  const patch = jsonPatchForRules(currentRules, proposedRules);
  const pending = {
    proposalId: proposalId(),
    stagedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
    baseVersion: Number.isFinite(state.version) ? state.version : 0,
    reason,
    source,
    currentRules,
    proposedRules,
    proposedPolicy: policy,
    patch,
    proposedRulesHash: hashJson(proposedRules),
    proposalHash: hashJson(policy)
  };
  await writeJson(pendingPath(config), pending);
  return pending;
}

async function clearPending(config) {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(pendingPath(config));
  } catch {
    // file may not exist
  }
}
