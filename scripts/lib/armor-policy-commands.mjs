import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isPlainObject } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";
import { loadPolicyState, savePolicyState } from "./policy.mjs";
import { canonicalPolicyHash, normalizePolicyIr, validatePolicyIr } from "./policy-ir.mjs";
import { getTemplate, getTemplateNames } from "./policy-templates.mjs";
import { listProfiles, loadProfile, saveProfile, deleteProfile } from "./policy-profiles.mjs";
import { listMcpServers, setMcpServerStatus } from "./tool-registry.mjs";
import { loadRuntimeState, saveRuntimeState } from "./runtime-state.mjs";
import {
  pushProfile as pushProfileToBackend,
  pullProfiles as pullProfilesFromBackend,
  syncPolicy as syncPolicyToBackend,
} from "./backend-client.mjs";

const PENDING_FILE = "policy-pending.json";
const DRAFTS_FILE = "policy-drafts.json";
const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const KNOWN_CLAUDE_TOOLS = new Set([
  "*",
  "Agent",
  "AskUserQuestion",
  "Bash",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "Explore",
  "Glob",
  "Grep",
  "ListMcpResourcesTool",
  "LSP",
  "Monitor",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "PowerShell",
  "PushNotification",
  "Read",
  "ReadMcpResourceTool",
  "RemoteTrigger",
  "ScheduleWakeup",
  "SendMessage",
  "ShareOnboardingGuide",
  "Skill",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TeamCreate",
  "TeamDelete",
  "TodoWrite",
  "ToolSearch",
  "WaitForMcpServers",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]);
const KNOWN_BASH_PROGRAMS = new Set([
  "awk",
  "cat",
  "curl",
  "find",
  "grep",
  "head",
  "jq",
  "less",
  "lf",
  "ls",
  "lsof",
  "nc",
  "netstat",
  "nmap",
  "sed",
  "ss",
  "tail",
  "tree",
  "psql",
  "gcloud",
  "kubectl",
  "aws",
  "az",
]);
const ADMIN_PROGRAMS = new Set(["psql", "gcloud", "kubectl", "aws", "az"]);
const NETWORK_PROGRAMS = new Set(["curl", "nc", "nmap"]);
const DRAFT_LIFECYCLE_FIELDS = new Set([
  "proposalId",
  "baseVersion",
  "proposalHash",
  "expiresAt",
  "proposedPolicy",
  "patch",
  "stagedAt",
]);

function splitCamelToolName(tool) {
  return String(tool)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/Mcp/g, "MCP")
    .toLowerCase();
}

const TOOL_ALIASES = new Map(
  [
    ...[...KNOWN_CLAUDE_TOOLS]
      .filter((tool) => tool !== "*")
      .flatMap((tool) => [
        [tool.toLowerCase(), tool],
        [splitCamelToolName(tool), tool],
        [splitCamelToolName(tool).replace(/\s+/g, "-"), tool],
        [splitCamelToolName(tool).replace(/\s+/g, "_"), tool],
      ]),
    ["agent", "Agent"],
    ["subagent", "Agent"],
    ["sub agent", "Agent"],
    ["sub-agent", "Agent"],
    ["ask user question", "AskUserQuestion"],
    ["ask user", "AskUserQuestion"],
    ["askuserquestion", "AskUserQuestion"],
    ["bash", "Bash"],
    ["shell", "Bash"],
    ["terminal", "Bash"],
    ["code search", "Grep"],
    ["content search", "Grep"],
    ["file search", "Glob"],
    ["read", "Read"],
    ["read files", "Read"],
    ["grep", "Grep"],
    ["glob", "Glob"],
    ["edit", "Edit"],
    ["write", "Write"],
    ["multi edit", "MultiEdit"],
    ["multi-edit", "MultiEdit"],
    ["multiedit", "MultiEdit"],
    ["notebook edit", "NotebookEdit"],
    ["notebook read", "NotebookRead"],
    ["powershell", "PowerShell"],
    ["power shell", "PowerShell"],
    ["skill", "Skill"],
    ["skills", "Skill"],
    ["todo", "TodoWrite"],
    ["todo write", "TodoWrite"],
    ["tool search", "ToolSearch"],
    ["toolsearch", "ToolSearch"],
    ["web fetch", "WebFetch"],
    ["webfetch", "WebFetch"],
    ["fetch web", "WebFetch"],
    ["web search", "WebSearch"],
    ["websearch", "WebSearch"],
    ["search web", "WebSearch"],
    ["workflow", "Workflow"],
  ].map(([alias, tool]) => [alias.toLowerCase(), tool])
);

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

function conditionText(condition) {
  if (!isPlainObject(condition)) return "";
  const value = Array.isArray(condition.value)
    ? `[${condition.value.join(", ")}]`
    : JSON.stringify(condition.value);
  return `${condition.field} ${condition.op} ${value}`;
}

function defaultDecisionText(policy) {
  const decision = normalizePolicyIr(policy).defaults.decision;
  if (decision === "allow") return "DEFAULT ALLOW unmatched tools";
  if (decision === "hold") return "DEFAULT ASK unmatched tools";
  return "DEFAULT BLOCK unmatched tools";
}

function programSetKey(programs) {
  return uniqueLines(programs).slice().sort().join("\u0000");
}

function statementPrograms(statement, op) {
  return conditionValues(statement, "bash.program", op);
}

function isBashToolStatement(statement) {
  return statement.action?.type === "tool" && actionValues(statement.action).includes("Bash");
}

function matchingBashForbidByProgramSet(statements) {
  const byKey = new Map();
  for (const statement of statements) {
    if (statement.effect !== "forbid" || !isBashToolStatement(statement)) continue;
    const blocked = statementPrograms(statement, "in");
    if (!blocked.length) continue;
    byKey.set(programSetKey(blocked), statement);
  }
  return byKey;
}

function matchingBashPermitByProgramSet(statements) {
  const byKey = new Map();
  for (const statement of statements) {
    if (statement.effect !== "permit" || !isBashToolStatement(statement)) continue;
    const exceptPrograms = statementPrograms(statement, "not_in");
    if (!exceptPrograms.length) continue;
    byKey.set(programSetKey(exceptPrograms), statement);
  }
  return byKey;
}

function statementReviewLine(statement, pairedStatement = null) {
  const action =
    statement.action?.eq ||
    (Array.isArray(statement.action?.in) ? statement.action.in.join(", ") : "*");
  const effect =
    statement.effect === "forbid"
      ? "BLOCK"
      : statement.effect === "require_approval"
        ? "ASK"
        : "ALLOW";
  const exceptPrograms =
    statement.effect === "permit" && isBashToolStatement(statement)
      ? statementPrograms(statement, "not_in")
      : [];
  if (exceptPrograms.length && pairedStatement) {
    return `${effect.padEnd(5)} ${statement.id}: Bash when bash.program not_in [${exceptPrograms.join(", ")}] (paired BLOCK guardrail: ${pairedStatement.id})`;
  }
  const blockedPrograms =
    statement.effect === "forbid" && isBashToolStatement(statement)
      ? statementPrograms(statement, "in")
      : [];
  if (blockedPrograms.length && pairedStatement) {
    return `${effect.padEnd(5)} ${statement.id}: Bash when bash.program in [${blockedPrograms.join(", ")}] (guardrail for ${pairedStatement.id})`;
  }
  const conditions = statement.conditions.length
    ? ` when ${statement.conditions.map(conditionText).filter(Boolean).join(" and ")}`
    : "";
  return `${effect.padEnd(5)} ${statement.id}: ${action}${conditions}`;
}

function summarizePolicyReview(policy) {
  const normalized = normalizePolicyIr(policy);
  const lines = [];
  const guardrails = matchingBashForbidByProgramSet(normalized.statements);
  const permits = matchingBashPermitByProgramSet(normalized.statements);
  for (const statement of normalized.statements) {
    const exceptPrograms =
      statement.effect === "permit" && isBashToolStatement(statement)
        ? statementPrograms(statement, "not_in")
        : [];
    const blockedPrograms =
      statement.effect === "forbid" && isBashToolStatement(statement)
        ? statementPrograms(statement, "in")
        : [];
    const paired = exceptPrograms.length
      ? guardrails.get(programSetKey(exceptPrograms))
      : blockedPrograms.length
        ? permits.get(programSetKey(blockedPrograms))
        : null;
    lines.push(statementReviewLine(statement, paired));
  }
  return lines.length ? lines.join("\n") : "(no statements)";
}

function policyReviewLines(policy) {
  const summary = summarizePolicyReview(policy);
  return summary === "(no statements)" ? [] : summary.split("\n");
}

function formatPolicyReviewDiff(currentPolicy, proposedPolicy) {
  const current = policyReviewLines(currentPolicy);
  const proposed = policyReviewLines(proposedPolicy);
  const currentSet = new Set(current);
  const proposedSet = new Set(proposed);
  const lines = [
    ...(defaultDecisionText(currentPolicy) === defaultDecisionText(proposedPolicy)
      ? []
      : [`- ${defaultDecisionText(currentPolicy)}`, `+ ${defaultDecisionText(proposedPolicy)}`]),
    ...current.filter((line) => !proposedSet.has(line)).map((line) => `- ${line}`),
    ...proposed.filter((line) => !currentSet.has(line)).map((line) => `+ ${line}`),
  ];
  return lines.length ? lines.join("\n") : "(no changes)";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function jsonPatchForPolicy(currentPolicy, proposedPolicy) {
  const current = normalizePolicyIr(currentPolicy);
  const proposed = normalizePolicyIr(proposedPolicy);
  const patch = [];
  if (stableJson(current.defaults) !== stableJson(proposed.defaults)) {
    patch.push({ op: "replace", path: "/defaults", value: proposed.defaults });
  }
  if (stableJson(current.metadata) !== stableJson(proposed.metadata)) {
    patch.push({ op: "replace", path: "/metadata", value: proposed.metadata });
  }
  const currentById = new Map(current.statements.map((statement) => [statement.id, statement]));
  const proposedById = new Map(proposed.statements.map((statement) => [statement.id, statement]));
  for (const statement of current.statements) {
    if (!proposedById.has(statement.id)) {
      patch.push({ op: "remove", path: `/statements/${statement.id}` });
    }
  }
  for (const statement of proposed.statements) {
    const existing = currentById.get(statement.id);
    if (!existing) {
      patch.push({ op: "add", path: "/statements/-", value: statement });
    } else if (stableJson(existing) !== stableJson(statement)) {
      patch.push({ op: "replace", path: `/statements/${statement.id}`, value: statement });
    }
  }
  return patch;
}

function uniqueLines(lines) {
  return [...new Set(lines.filter((line) => typeof line === "string" && line.trim()))];
}

function actionTools(statement) {
  if (!isPlainObject(statement?.action)) return ["*"];
  if (typeof statement.action.eq === "string") return [statement.action.eq];
  if (Array.isArray(statement.action.in))
    return statement.action.in.filter((entry) => typeof entry === "string");
  return ["*"];
}

function conditionValues(statement, field, op = "") {
  return (Array.isArray(statement?.conditions) ? statement.conditions : [])
    .filter((condition) => condition?.field === field && (!op || condition.op === op))
    .flatMap((condition) => (Array.isArray(condition.value) ? condition.value : [condition.value]))
    .filter((value) => typeof value === "string" && value);
}

function riskWarningsForPolicy(policy) {
  const normalized = normalizePolicyIr(policy);
  const warnings = [];
  const guardrails = matchingBashForbidByProgramSet(normalized.statements);
  const guardrailIds = new Set(
    normalized.statements
      .filter((statement) => statement.effect === "permit" && isBashToolStatement(statement))
      .map(
        (statement) =>
          guardrails.get(programSetKey(conditionValues(statement, "bash.program", "not_in")))?.id
      )
      .filter(Boolean)
  );
  if (normalized.defaults.decision === "allow") {
    warnings.push("RISK Default allow permits unmatched tools.");
  } else if (normalized.defaults.decision === "hold") {
    warnings.push("ASK Default hold asks for approval when no statement matches.");
  }
  for (const statement of normalized.statements) {
    const tools = actionTools(statement);
    const isPermit = statement.effect === "permit";
    const isForbid = statement.effect === "forbid";
    const permitsBash = isPermit && tools.includes("Bash");
    const permitsWriteTools =
      isPermit && tools.some((tool) => ["Write", "Edit", "MultiEdit"].includes(tool));
    if (permitsWriteTools) {
      warnings.push("RISK Write/Edit/MultiEdit can change workspace files.");
    }
    if (permitsBash && !statement.conditions.length) {
      warnings.push("RISK Bash is broadly allowed with no program restrictions.");
    }
    if (permitsBash && conditionValues(statement, "bash.program", "not_in").length) {
      const exceptPrograms = conditionValues(statement, "bash.program", "not_in");
      const guardrail = guardrails.get(programSetKey(exceptPrograms));
      warnings.push(
        guardrail
          ? `RISK Bash is broadly allowed except: ${exceptPrograms.join(", ")}. Exceptions are explicitly blocked by guardrail ${guardrail.id}.`
          : `RISK Bash is broadly allowed except: ${exceptPrograms.join(", ")}.`
      );
    }
    const allowedPrograms = conditionValues(statement, "bash.program", "in");
    if (isPermit && allowedPrograms.some((program) => NETWORK_PROGRAMS.has(program))) {
      warnings.push(
        `RISK Network-capable Bash programs allowed: ${allowedPrograms.filter((program) => NETWORK_PROGRAMS.has(program)).join(", ")}.`
      );
    }
    if (isPermit && allowedPrograms.some((program) => ADMIN_PROGRAMS.has(program))) {
      warnings.push(
        `RISK Cloud/db/admin Bash programs allowed: ${allowedPrograms.filter((program) => ADMIN_PROGRAMS.has(program)).join(", ")}.`
      );
    }
    const blockedPrograms = conditionValues(statement, "bash.program", "in");
    if (
      isForbid &&
      !guardrailIds.has(statement.id) &&
      blockedPrograms.some((program) => ADMIN_PROGRAMS.has(program))
    ) {
      warnings.push(
        `BLOCK Cloud/db/admin Bash programs explicitly denied: ${blockedPrograms.filter((program) => ADMIN_PROGRAMS.has(program)).join(", ")}.`
      );
    }
  }
  return uniqueLines(warnings);
}

function draftRiskWarnings(astWarnings, policy) {
  const policyWarnings = riskWarningsForPolicy(policy);
  const hasGuardrailWarning = policyWarnings.some((warning) =>
    warning.includes("Exceptions are explicitly blocked by guardrail")
  );
  const filteredAstWarnings = (Array.isArray(astWarnings) ? astWarnings : []).filter((warning) => {
    if (!hasGuardrailWarning) return true;
    return (
      !warning.startsWith("RISK Bash is broadly allowed except:") &&
      !warning.startsWith("BLOCK Cloud/db/admin Bash programs explicitly denied:")
    );
  });
  return uniqueLines([...filteredAstWarnings, ...policyWarnings]);
}

function formatOptionalList(items, empty = "(none)") {
  const values = uniqueLines(Array.isArray(items) ? items : []);
  return values.length ? values.map((entry) => `- ${entry}`).join("\n") : empty;
}

function formatProposal(pending, currentPolicy, proposedPolicy, title = "Proposed policy change:") {
  const reviewDiff = formatPolicyReviewDiff(currentPolicy, proposedPolicy);
  return [
    title,
    pending.source?.type ? `Source: ${pending.source.type}` : "",
    `Proposal: ${pending.proposalId}`,
    `Base policy: v${pending.baseVersion}`,
    "",
    "Review:",
    defaultDecisionText(proposedPolicy),
    summarizePolicyReview(proposedPolicy),
    "",
    "Risk warnings:",
    formatOptionalList(riskWarningsForPolicy(proposedPolicy)),
    "",
    "Patch:",
    JSON.stringify(pending.patch || jsonPatchForPolicy(currentPolicy, proposedPolicy), null, 2),
    "",
    "Diff:",
    reviewDiff,
    "",
    "JSON proposal:",
    JSON.stringify(
      {
        proposalId: pending.proposalId,
        baseVersion: pending.baseVersion,
        basePolicyHash: pending.basePolicyHash,
        proposalHash: pending.proposalHash,
        expiresAt: pending.expiresAt,
        policy: pending.proposedPolicy,
      },
      null,
      2
    ),
    "",
    "Next:",
    `  /armorclaude:armor yes                         apply ${pending.proposalId}`,
    `  /armorclaude:armor no                          discard ${pending.proposalId}`,
    `  /armorclaude:armor policy confirm ${pending.proposalId}`,
    `  /armorclaude:armor policy cancel ${pending.proposalId}`,
  ].join("\n");
}

function formatDraft(draft) {
  const riskWarnings = draft.riskWarnings || riskWarningsForPolicy(draft.policy);
  const diff = draft.diff || "(not compared to active policy)";
  return [
    "Drafted from natural language. Not staged.",
    "",
    `Draft: ${draft.draftId}`,
    draft.confidence ? `Confidence: ${draft.confidence}` : "",
    "",
    "Review:",
    defaultDecisionText(draft.policy),
    summarizePolicyReview(draft.policy),
    "",
    "Risk warnings:",
    formatOptionalList(riskWarnings),
    "",
    "Diff:",
    diff,
    "",
    "Ambiguities:",
    formatOptionalList(draft.ambiguities, "(none)"),
    "",
    "Normalized JSON:",
    JSON.stringify(draft.policy, null, 2),
    "",
    "Next:",
    `  /armorclaude:armor policy stage ${draft.draftId}`,
    `  /armorclaude:armor policy revise ${draft.draftId} "clarify what should change"`,
    "  /armorclaude:armor no",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function formatDraftRevision({ original, revised, removedIds, note }) {
  const riskWarnings = revised.riskWarnings || riskWarningsForPolicy(revised.policy);
  return [
    "Draft revised. Not staged.",
    "",
    `Previous draft: ${original.draftId}`,
    `New draft: ${revised.draftId}`,
    note ? `Note: ${note}` : "",
    removedIds.length ? `Removed statements: ${removedIds.join(", ")}` : "",
    "",
    "Review:",
    defaultDecisionText(revised.policy),
    summarizePolicyReview(revised.policy),
    "",
    "Risk warnings:",
    formatOptionalList(riskWarnings),
    "",
    "Changes:",
    formatPolicyReviewDiff(original.policy, revised.policy),
    "",
    "Normalized JSON:",
    JSON.stringify(revised.policy, null, 2),
    "",
    "Next:",
    `  /armorclaude:armor policy stage ${revised.draftId}`,
    `  /armorclaude:armor policy revise ${revised.draftId} "clarify what should change"`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

async function issueCryptoPolicyTokenForState(config, policyState) {
  if (!config.cryptoPolicyEnabled) {
    return { ok: true, note: "" };
  }
  try {
    const { createCryptoPolicyService } = await import("./crypto-policy.mjs");
    const cryptoService = createCryptoPolicyService(config);
    await cryptoService.issuePolicyToken(policyState, {
      userId: config.userId,
      agentId: config.agentId,
      contextId: config.contextId,
    });
    return { ok: true, note: " Crypto policy token issued." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function clearCryptoPolicyToken(config) {
  if (!config.cryptoPolicyEnabled) return;
  try {
    const { createCryptoPolicyService } = await import("./crypto-policy.mjs");
    await createCryptoPolicyService(config).clearCache();
  } catch {
    // Clearing stale crypto cache is best-effort; local policy remains authoritative.
  }
}

function isEmptyDefaultDenyPolicy(policy) {
  const normalized = normalizePolicyIr(policy);
  return normalized.defaults.decision === "deny" && normalized.statements.length === 0;
}

function canApplyFailClosedWhenCryptoFails(pending, proposedPolicy) {
  return pending?.reason === "reset policy statements" && isEmptyDefaultDenyPolicy(proposedPolicy);
}

function nextPolicyId(policy) {
  const ids = normalizePolicyIr(policy)
    .statements.map((statement) => statement.id.match(/^policy(\d+)$/i))
    .filter(Boolean)
    .map((match) => parseInt(match[1], 10));
  return `policy${(ids.length ? Math.max(...ids) : 0) + 1}`;
}

function emptyPolicy(name = "current") {
  return normalizePolicyIr({
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name, description: "" },
    defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    statements: [],
  });
}

function normalizeDefaultDecision(raw) {
  const value =
    typeof raw === "string"
      ? raw
          .toLowerCase()
          .replace(/[-\s]+/g, "_")
          .trim()
      : "";
  if (["allow", "deny", "hold"].includes(value)) return value;
  if (["ask", "approval", "require_approval"].includes(value)) return "hold";
  return "";
}

function withDefaultDecision(policy, decision) {
  const current = normalizePolicyIr(policy);
  return normalizePolicyIr({
    ...current,
    defaults: {
      ...current.defaults,
      decision,
    },
  });
}

function effectForCommandAction(action) {
  if (action === "deny") return "forbid";
  if (action === "require_approval") return "require_approval";
  return "permit";
}

function isBashProgramTool(tool) {
  const value = typeof tool === "string" ? tool.trim().toLowerCase() : "";
  return value && !KNOWN_CLAUDE_TOOLS.has(tool) && KNOWN_BASH_PROGRAMS.has(value);
}

function statementForCommandRule(rule, id) {
  const effect = effectForCommandAction(rule.action);
  const tool = typeof rule.tool === "string" && rule.tool.trim() ? rule.tool.trim() : "*";
  const program = tool.toLowerCase();
  if (isBashProgramTool(tool)) {
    return {
      id,
      effect,
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [
        { field: "bash.program", op: "in", value: [program] },
        ...(effect === "permit"
          ? [{ field: "bash.hasWriteRedirection", op: "eq", value: false }]
          : []),
      ],
    };
  }
  return {
    id,
    effect,
    principal: { type: "agent", id: "claude-code" },
    action: { type: "tool", eq: tool },
    resource: { type: "workspace", scope: "current" },
    conditions: [],
  };
}

function appendRuleToPolicy(policy, rule) {
  const current = normalizePolicyIr(policy);
  return normalizePolicyIr({
    ...current,
    statements: [...current.statements, statementForCommandRule(rule, rule.id)],
  });
}

function removeStatementFromPolicy(policy, id) {
  const current = normalizePolicyIr(policy);
  return normalizePolicyIr({
    ...current,
    statements: current.statements.filter((statement) => statement.id !== id),
  });
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

function findLifecycleFields(value, pathName = "$") {
  if (Array.isArray(value)) {
    return value.flatMap((entry, idx) => findLifecycleFields(entry, `${pathName}[${idx}]`));
  }
  if (!isPlainObject(value)) return [];
  const matches = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${pathName}.${key}`;
    if (DRAFT_LIFECYCLE_FIELDS.has(key)) matches.push(childPath);
    matches.push(...findLifecycleFields(child, childPath));
  }
  return matches;
}

function validateDraftPolicyJson(parsedJson) {
  const lifecycleFields = findLifecycleFields(parsedJson);
  if (lifecycleFields.length) {
    return {
      ok: false,
      errors: [
        `Draft JSON cannot set lifecycle/staging fields: ${lifecycleFields.slice(0, 8).join(", ")}`,
      ],
    };
  }
  return validatePolicyIr(parsedJson);
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
  const policy = normalizePolicyIr(draft.policy);
  const removedIds = [];
  let statements = policy.statements;
  const deniedProgramRevision = parseDenyProgramRevision(raw);

  const removeMatch = raw.match(
    /\b(?:remove|delete|drop)\b\s+(?:the\s+)?([a-z0-9_-]+)(?:\s+(?:id|statement|rule))?/i
  );
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
  } else if (deniedProgramRevision.length) {
    statements = applyDenyProgramRevision(statements, deniedProgramRevision, removedIds);
  } else if (/\ballow\s+explore\b/i.test(raw)) {
    statements = [
      ...statements,
      {
        id: "allow-explore",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Explore" },
        resource: { type: "workspace", scope: "current" },
        conditions: [],
      },
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
        conditions: [],
      },
    ];
  } else if (/\bdefault\s+allow\b|\ballow\s+by\s+default\b/i.test(raw)) {
    policy.defaults.decision = "allow";
  } else if (/\bdefault\s+deny\b|\bdeny\s+by\s+default\b/i.test(raw)) {
    policy.defaults.decision = "deny";
  } else if (
    /\bdefault\s+hold\b|\bhold\s+by\s+default\b|\bdefault\s+ask\b|\bask\s+by\s+default\b|\brequire\s+approval\s+by\s+default\b/i.test(
      raw
    )
  ) {
    policy.defaults.decision = "hold";
  } else {
    return {
      ok: false,
      error: [
        "Could not revise that draft deterministically.",
        "Supported revise examples:",
        `  /armorclaude:armor policy revise ${draft.draftId} "block gcloud and psql in Bash"`,
        `  /armorclaude:armor policy revise ${draft.draftId} "remove <statement-id>"`,
        `  /armorclaude:armor policy revise ${draft.draftId} "allow Explore"`,
        `  /armorclaude:armor policy revise ${draft.draftId} "default hold"`,
      ].join("\n"),
    };
  }

  const revisedPolicy = normalizePolicyIr({
    ...policy,
    metadata: {
      ...policy.metadata,
      description: `${policy.metadata.description || ""}\nRevision: ${raw}`.trim(),
    },
    statements,
  });
  const result = validatePolicyIr(revisedPolicy);
  if (!result.ok)
    return {
      ok: false,
      error: `Revised draft failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}`,
    };
  return {
    ok: true,
    removedIds,
    policy: result.policy,
  };
}

function parseDenyProgramRevision(raw) {
  if (!/\b(?:deny|block|forbid|disallow|do\s+not\s+allow)\b/i.test(raw)) return [];
  if (!/\b(?:bash|shell|terminal|command|program)\b/i.test(raw)) return [];
  return mentionedPrograms(raw);
}

function actionValues(action) {
  if (typeof action?.eq === "string") return [action.eq];
  if (Array.isArray(action?.in)) return action.in.filter((entry) => typeof entry === "string");
  return [];
}

function hasBashProgramCondition(statement, op) {
  return statement.conditions.some(
    (condition) => condition.field === "bash.program" && condition.op === op
  );
}

function appendProgramsToCondition(conditions, op, programs) {
  let found = false;
  const next = conditions.map((condition) => {
    if (condition.field !== "bash.program" || condition.op !== op) return condition;
    found = true;
    return {
      ...condition,
      value: uniqueLines([...(Array.isArray(condition.value) ? condition.value : []), ...programs]),
    };
  });
  if (!found) next.push({ field: "bash.program", op, value: programs });
  return next;
}

function removeProgramsFromInConditions(conditions, programs) {
  return conditions
    .map((condition) => {
      if (
        condition.field !== "bash.program" ||
        condition.op !== "in" ||
        !Array.isArray(condition.value)
      ) {
        return condition;
      }
      return {
        ...condition,
        value: condition.value.filter((program) => !programs.includes(program)),
      };
    })
    .filter(
      (condition) =>
        !(
          condition.field === "bash.program" &&
          condition.op === "in" &&
          Array.isArray(condition.value) &&
          condition.value.length === 0
        )
    );
}

function removeProgramsFromConditionOp(conditions, op, programs) {
  return conditions
    .map((condition) => {
      if (
        condition.field !== "bash.program" ||
        condition.op !== op ||
        !Array.isArray(condition.value)
      ) {
        return condition;
      }
      return {
        ...condition,
        value: condition.value.filter((program) => !programs.includes(program)),
      };
    })
    .filter(
      (condition) =>
        !(
          condition.field === "bash.program" &&
          condition.op === op &&
          Array.isArray(condition.value) &&
          condition.value.length === 0
        )
    );
}

function denyStatementIdForPrograms(programs) {
  return programs.some((program) => ADMIN_PROGRAMS.has(program))
    ? "forbid-cloud-db-admin"
    : "forbid-bash-programs";
}

function applyDenyProgramRevision(statements, programs, removedIds) {
  const denied = uniqueLines(programs);
  const denyId = denyStatementIdForPrograms(denied);
  let denyUpdated = false;
  const next = [];

  for (const statement of statements) {
    if (
      statement.action?.type === "tool" &&
      actionValues(statement.action).includes("Bash") &&
      statement.effect === "permit"
    ) {
      const conditions = hasBashProgramCondition(statement, "not_in")
        ? appendProgramsToCondition(statement.conditions, "not_in", denied)
        : removeProgramsFromInConditions(statement.conditions, denied);
      const shouldRemoveStatement =
        statement.conditions.some(
          (condition) => condition.field === "bash.program" && condition.op === "in"
        ) &&
        !conditions.some(
          (condition) => condition.field === "bash.program" && condition.op === "in"
        );
      if (shouldRemoveStatement) {
        removedIds.push(statement.id);
        continue;
      }
      next.push({ ...statement, conditions });
      continue;
    }

    if (statement.id === denyId && statement.effect === "forbid") {
      denyUpdated = true;
      next.push({
        ...statement,
        action: { type: "tool", eq: "Bash" },
        conditions: appendProgramsToCondition(
          statement.conditions.filter(
            (condition) => condition.field !== "bash.hasWriteRedirection"
          ),
          "in",
          denied
        ),
      });
      continue;
    }

    next.push(statement);
  }

  if (!denyUpdated) {
    next.push({
      id: denyId,
      effect: "forbid",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [{ field: "bash.program", op: "in", value: denied }],
    });
  }

  return next;
}

function statementTargetsBash(statement) {
  return (
    statement.action?.type === "tool" &&
    actionValues(statement.action).some((value) => value === "Bash" || value === "*")
  );
}

function hasAnyBashProgramCondition(statement) {
  return statement.conditions.some((condition) => condition.field === "bash.program");
}

function mergeToolEffect(statements, tools, effect, preferredId) {
  const selected = uniqueLines(tools).filter(
    (tool) => KNOWN_CLAUDE_TOOLS.has(tool) && tool !== "Bash" && tool !== "*"
  );
  if (!selected.length) return statements;
  let merged = false;
  const next = statements.map((statement) => {
    if (
      merged ||
      statement.effect !== effect ||
      statement.action?.type !== "tool" ||
      statementTargetsBash(statement) ||
      statement.conditions.length
    ) {
      return statement;
    }
    const values = actionValues(statement.action).filter(
      (tool) => KNOWN_CLAUDE_TOOLS.has(tool) && tool !== "Bash" && tool !== "*"
    );
    if (!values.length) return statement;
    merged = true;
    return {
      ...statement,
      action:
        values.length + selected.length === 1
          ? { type: "tool", eq: values[0] || selected[0] }
          : { type: "tool", in: uniqueLines([...values, ...selected]) },
    };
  });
  if (merged) return next;
  return [
    ...next,
    {
      id: preferredId,
      effect,
      principal: { type: "agent", id: "claude-code" },
      action:
        selected.length === 1 ? { type: "tool", eq: selected[0] } : { type: "tool", in: selected },
      resource: { type: "workspace", scope: "current" },
      conditions: [],
    },
  ];
}

function mergeToolPermit(statements, tools, preferredId) {
  return mergeToolEffect(statements, tools, "permit", preferredId);
}

function mergeToolForbid(statements, tools, preferredId) {
  return mergeToolEffect(statements, tools, "forbid", preferredId);
}

function mergeToolHold(statements, tools, preferredId) {
  return mergeToolEffect(statements, tools, "require_approval", preferredId);
}

function mergeAllowedBashPrograms(statements, programs) {
  const allowed = uniqueLines(programs);
  if (!allowed.length) return statements;
  const covered = new Set();
  const next = [];

  for (const statement of statements) {
    if (!statementTargetsBash(statement)) {
      next.push(statement);
      continue;
    }

    if (statement.effect === "forbid") {
      const hadIn = hasBashProgramCondition(statement, "in");
      const conditions = removeProgramsFromConditionOp(statement.conditions, "in", allowed);
      if (
        hadIn &&
        !conditions.some((condition) => condition.field === "bash.program" && condition.op === "in")
      ) {
        continue;
      }
      next.push({ ...statement, conditions });
      continue;
    }

    if (statement.effect === "permit") {
      if (hasBashProgramCondition(statement, "not_in")) {
        next.push({
          ...statement,
          conditions: removeProgramsFromConditionOp(statement.conditions, "not_in", allowed),
        });
        allowed.forEach((program) => covered.add(program));
        continue;
      }
      if (hasBashProgramCondition(statement, "in")) {
        next.push({
          ...statement,
          conditions: appendProgramsToCondition(statement.conditions, "in", allowed),
        });
        allowed.forEach((program) => covered.add(program));
        continue;
      }
      if (!hasAnyBashProgramCondition(statement)) {
        next.push(statement);
        allowed.forEach((program) => covered.add(program));
        continue;
      }
    }

    next.push(statement);
  }

  const missing = allowed.filter((program) => !covered.has(program));
  if (!missing.length) return next;
  return [
    ...next,
    {
      id: "allow-safe-bash-inspection",
      effect: "permit",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [
        { field: "bash.program", op: "in", value: missing },
        { field: "bash.hasWriteRedirection", op: "eq", value: false },
      ],
    },
  ];
}

function removeProgramsFromForbidStatements(statements, programs) {
  const removed = uniqueLines(programs);
  if (!removed.length) return statements;
  const next = [];
  for (const statement of statements) {
    if (statement.effect !== "forbid" || !statementTargetsBash(statement)) {
      next.push(statement);
      continue;
    }
    const hadIn = hasBashProgramCondition(statement, "in");
    const conditions = removeProgramsFromConditionOp(statement.conditions, "in", removed);
    if (
      hadIn &&
      !conditions.some((condition) => condition.field === "bash.program" && condition.op === "in")
    ) {
      continue;
    }
    next.push({ ...statement, conditions });
  }
  return next;
}

function ensureBroadBashExcept(statements, programs) {
  const denied = uniqueLines(programs);
  if (!denied.length) return statements;
  let found = false;
  const next = statements.map((statement) => {
    if (statement.effect !== "permit" || !statementTargetsBash(statement)) return statement;
    if (hasBashProgramCondition(statement, "not_in")) {
      found = true;
      return {
        ...statement,
        conditions: appendProgramsToCondition(statement.conditions, "not_in", denied),
      };
    }
    if (!hasAnyBashProgramCondition(statement)) {
      found = true;
      return {
        ...statement,
        conditions: [
          ...statement.conditions,
          { field: "bash.program", op: "not_in", value: denied },
        ],
      };
    }
    return statement;
  });
  if (found) return next;
  return [
    ...next,
    {
      id: "allow-bash-except-denied-programs",
      effect: "permit",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [{ field: "bash.program", op: "not_in", value: denied }],
    },
  ];
}

function rawMentionsPolicyCreation(raw) {
  return /\b(name\s+(?:the\s+)?policy|save\s+(?:this\s+)?as|only\s+allow|policy\s+should|should\s+only)\b/i.test(
    raw
  );
}

function rawMentionsFileTools(raw) {
  return /\b(read\s+tools?|file\s+tools?|read\/write|write|edit|modify|change|create files?|update files?)\b/i.test(
    raw
  );
}

function rawMentionsDefaultDecision(raw) {
  return /\b(default\s+(?:allow|deny|hold|ask)|(?:allow|deny|hold|ask)\s+by\s+default|require\s+approval\s+by\s+default)\b/i.test(
    raw
  );
}

function maybeBuildAdditivePolicy(raw, ast, currentPolicy) {
  if (!/^\s*add\b/i.test(raw) || rawMentionsPolicyCreation(raw)) return null;
  let statements = [...currentPolicy.statements];
  const removedIds = [];
  const denied = ast.bash.deniedPrograms;
  const allowed = ast.bash.allowedPrograms;
  const allowedTools = ast.tools?.allowed || [];
  const deniedTools = ast.tools?.denied || [];
  const heldTools = ast.tools?.held || [];

  if (rawMentionsFileTools(raw) || allowedTools.length) {
    statements = mergeToolPermit(
      statements,
      uniqueLines([...ast.fileTools, ...allowedTools]),
      ast.fileTools.some((tool) => ["Write", "Edit", "MultiEdit"].includes(tool))
        ? "allow-file-tools"
        : "allow-read-tools"
    );
  }
  if (deniedTools.length) {
    statements = mergeToolForbid(statements, deniedTools, "forbid-tools");
  }
  if (heldTools.length) {
    statements = mergeToolHold(statements, heldTools, "hold-tools");
  }

  if ((ast.bash.allowAll || ast.bash.broadExceptDenied) && denied.length) {
    statements = ensureBroadBashExcept(statements, denied);
    statements = ast.bash.removeExplicitForbid
      ? removeProgramsFromForbidStatements(statements, denied)
      : applyDenyProgramRevision(statements, denied, removedIds);
  } else if (denied.length) {
    statements = ast.bash.removeExplicitForbid
      ? removeProgramsFromForbidStatements(statements, denied)
      : applyDenyProgramRevision(statements, denied, removedIds);
  }

  if (ast.bash.allowAll && !denied.length) {
    if (
      !statements.some(
        (statement) =>
          statement.effect === "permit" &&
          statementTargetsBash(statement) &&
          !hasAnyBashProgramCondition(statement)
      )
    ) {
      statements.push({
        id: "allow-all-bash",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Bash" },
        resource: { type: "workspace", scope: "current" },
        conditions: [],
      });
    }
  } else if (allowed.length) {
    statements = mergeAllowedBashPrograms(statements, allowed);
  }

  if (
    !rawMentionsFileTools(raw) &&
    !allowedTools.length &&
    !deniedTools.length &&
    !heldTools.length &&
    !denied.length &&
    !allowed.length &&
    !ast.bash.allowAll
  )
    return null;

  return normalizePolicyIr({
    ...currentPolicy,
    metadata: {
      ...currentPolicy.metadata,
      name: ast.profileName !== "draft-policy" ? ast.profileName : currentPolicy.metadata.name,
      description: `${currentPolicy.metadata.description || ""}\nDrafted from: ${raw}`.trim(),
    },
    defaults: rawMentionsDefaultDecision(raw)
      ? { ...currentPolicy.defaults, decision: ast.defaults.decision }
      : currentPolicy.defaults,
    statements,
  });
}

function tokenizePolicyText(raw) {
  return (typeof raw === "string" ? raw.toLowerCase() : "").match(/[a-z0-9_-]+/g) || [];
}

function programHasDenyContext(raw, program) {
  const escaped = program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(
      `\\b(?:deny|block|forbid|except|expect|exclude|without|not|disallow|do\\s+not\\s+allow)\\b(?:(?!\\ballow\\b)[\\s\\S]){0,100}\\b${escaped}\\b`,
      "i"
    ).test(raw) ||
    new RegExp(
      `\\b${escaped}\\b[\\s\\S]{0,60}\\b(?:denied|blocked|forbidden|disallowed)\\b`,
      "i"
    ).test(raw)
  );
}

function toolHasDenyContext(raw, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(
      `\\b(?:deny|block|forbid|exclude|without|not|disallow|do\\s+not\\s+allow)\\b(?:(?!\\b(?:allow|permit|hold|ask|require\\s+approval)\\b)[\\s\\S]){0,100}\\b${escaped}\\b`,
      "i"
    ).test(raw) ||
    new RegExp(
      `\\b${escaped}\\b[\\s\\S]{0,60}\\b(?:denied|blocked|forbidden|disallowed)\\b`,
      "i"
    ).test(raw)
  );
}

function toolHasHoldContext(raw, alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(
      `\\b(?:hold|ask\\s+before|require\\s+approval|approval\\s+required)\\b(?:(?!\\b(?:allow|permit|deny|block|forbid)\\b)[\\s\\S]){0,100}\\b${escaped}\\b`,
      "i"
    ).test(raw) ||
    new RegExp(`\\b${escaped}\\b[\\s\\S]{0,60}\\b(?:held|ask|approval\\s+required)\\b`, "i").test(
      raw
    )
  );
}

function mentionedPrograms(raw) {
  return [...KNOWN_BASH_PROGRAMS]
    .map((program) => ({
      program,
      index: raw
        .toLowerCase()
        .search(new RegExp(`\\b${program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")),
    }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.program);
}

function mentionedClaudeTools(raw) {
  const found = [];
  const seen = new Set();
  for (const [alias, tool] of TOOL_ALIASES.entries()) {
    if (tool === "*" || tool === "Bash") continue;
    const pattern = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const match = raw.match(pattern);
    if (!match || seen.has(tool)) continue;
    seen.add(tool);
    found.push({
      tool,
      alias,
      index: match.index ?? 0,
      action: toolHasDenyContext(raw, alias)
        ? "deny"
        : toolHasHoldContext(raw, alias)
          ? "hold"
          : "allow",
    });
  }
  return found.sort((a, b) => a.index - b.index);
}

export function buildPolicyIntentAst(rawInput) {
  const raw = typeof rawInput === "string" ? rawInput.trim() : "";
  const tokens = tokenizePolicyText(raw);
  const name =
    raw.match(/save\s+(?:this\s+)?as\s+([a-z0-9_-]+)/i)?.[1] ||
    raw.match(/name\s+(?:the\s+)?policy\s+([a-z0-9_-]+)/i)?.[1] ||
    raw.match(/name\s+(?:this\s+)?profile\s+(?:as\s+)?([a-z0-9_-]+)/i)?.[1] ||
    raw.match(/profile\s+(?:name\s+)?(?:as\s+)?([a-z0-9_-]+)/i)?.[1] ||
    "draft-policy";
  const writesMentioned =
    /\b(write|edit|modify|change|create files?|update files?|read\/write)\b/i.test(raw);
  const allowAllBash =
    /\ballow\s+all\s+bash\b/i.test(raw) ||
    /\bbash\s+tool\s+is\s+allowed\s+for\s+all\b/i.test(raw) ||
    /\bbash\b[\s\S]*\b(any|all)\s+commands?\b/i.test(raw);
  const broadBashExceptDenied =
    /\b(other things using bash|use other things using bash|bash but not|except|expect|not these|anything else using bash)\b/i.test(
      raw
    ) ||
    (/\bdo not allow\b/i.test(raw) && /\bbash\b/i.test(raw));
  const removeExplicitForbid =
    /\b(remove|delete|drop)\b[\s\S]*\bforbid\b/i.test(raw) ||
    /\bremove\b[\s\S]*\bcloud\b[\s\S]*\bdb\b[\s\S]*\badmin\b/i.test(raw);
  const defaultDecision =
    /\b(default hold|hold by default|default ask|ask by default|require approval by default)\b/i.test(
      raw
    )
      ? "hold"
      : /\b(default allow|allow by default)\b/i.test(raw)
        ? "allow"
        : "deny";
  const ambiguities = [];
  const riskWarnings = [];
  const deniedPrograms = [];
  const allowedPrograms = [];
  const allowedTools = [];
  const deniedTools = [];
  const heldTools = [];

  for (const program of mentionedPrograms(raw)) {
    if (programHasDenyContext(raw, program)) {
      deniedPrograms.push(program);
    } else if (!allowedPrograms.includes(program)) {
      allowedPrograms.push(program);
    }
  }
  for (const entry of mentionedClaudeTools(raw)) {
    if (entry.action === "deny") {
      if (!deniedTools.includes(entry.tool)) deniedTools.push(entry.tool);
    } else if (entry.action === "hold") {
      if (!heldTools.includes(entry.tool)) heldTools.push(entry.tool);
    } else if (!allowedTools.includes(entry.tool)) {
      allowedTools.push(entry.tool);
    }
  }
  if (/\bport checks?\b|\bport access\b/i.test(raw)) {
    for (const program of ["lsof", "netstat", "ss"]) {
      if (!allowedPrograms.includes(program)) allowedPrograms.push(program);
    }
  }
  if (allowAllBash && !deniedPrograms.length) {
    riskWarnings.push(
      "RISK All Bash commands are allowed. This is powerful and should only be staged for trusted workspaces."
    );
  }
  if (deniedPrograms.length && (allowAllBash || broadBashExceptDenied)) {
    riskWarnings.push(`RISK Bash is broadly allowed except: ${deniedPrograms.join(", ")}.`);
  }
  if (writesMentioned) {
    riskWarnings.push(
      "RISK Write/Edit/MultiEdit are included because the request mentioned writing or editing files."
    );
  }
  if (
    allowedTools.some((tool) =>
      [
        "Write",
        "Edit",
        "MultiEdit",
        "Bash",
        "PowerShell",
        "Monitor",
        "WebFetch",
        "WebSearch",
        "Skill",
        "Workflow",
        "Agent",
      ].includes(tool)
    )
  ) {
    riskWarnings.push(
      `RISK Powerful Claude tools explicitly allowed: ${allowedTools.filter((tool) => ["Write", "Edit", "MultiEdit", "Bash", "PowerShell", "Monitor", "WebFetch", "WebSearch", "Skill", "Workflow", "Agent"].includes(tool)).join(", ")}.`
    );
  }
  if (deniedTools.length) {
    riskWarnings.push(`BLOCK Claude tools explicitly denied: ${deniedTools.join(", ")}.`);
  }
  if (heldTools.length) {
    riskWarnings.push(`ASK Claude tools require approval: ${heldTools.join(", ")}.`);
  }
  if (allowedPrograms.some((program) => NETWORK_PROGRAMS.has(program))) {
    riskWarnings.push(
      `RISK Network-capable Bash programs mentioned: ${allowedPrograms.filter((program) => NETWORK_PROGRAMS.has(program)).join(", ")}.`
    );
  }
  if (deniedPrograms.some((program) => ADMIN_PROGRAMS.has(program))) {
    riskWarnings.push(
      `BLOCK Cloud/db/admin Bash programs explicitly denied: ${deniedPrograms.filter((program) => ADMIN_PROGRAMS.has(program)).join(", ")}.`
    );
  }
  if (/\b(file access|files? access)\b/i.test(raw)) {
    ambiguities.push(
      "AMBIGUOUS file access could mean read-only or write access. This draft defaults to read-oriented tools unless writing was explicit."
    );
  }
  if (/\bexpect\b/i.test(raw) && deniedPrograms.length) {
    ambiguities.push(
      "AMBIGUOUS interpreted 'expect' as 'except' because it appeared before denied Bash programs."
    );
  }
  if (/\b(network access|internal domains?|all urls?|external urls?)\b/i.test(raw)) {
    ambiguities.push(
      "AMBIGUOUS network access needs host/domain scoping before this should be staged."
    );
  }
  if (/\b(safe commands?|admin tools?)\b/i.test(raw)) {
    ambiguities.push("AMBIGUOUS vague command groups need explicit programs.");
  }
  if (/\bport checks?\b|\bport access\b/i.test(raw)) {
    ambiguities.push(
      "AMBIGUOUS port checks could mean lsof, netstat, ss, nc, or nmap. This draft permits lsof/netstat/ss only."
    );
  }

  const confidence = ambiguities.length
    ? "ambiguous"
    : riskWarnings.length
      ? "risky_exact"
      : "exact";

  return {
    version: "armor.policy.intent.v1",
    raw,
    tokens,
    confidence,
    profileName: name,
    defaults: { decision: defaultDecision },
    fileTools: writesMentioned
      ? uniqueLines([
          "Read",
          "Grep",
          "Glob",
          "Write",
          "Edit",
          "MultiEdit",
          ...allowedTools.filter((tool) =>
            ["Read", "Grep", "Glob", "Write", "Edit", "MultiEdit"].includes(tool)
          ),
        ])
      : uniqueLines([
          "Read",
          "Grep",
          "Glob",
          ...allowedTools.filter((tool) => ["Read", "Grep", "Glob"].includes(tool)),
        ]),
    tools: {
      allowed: uniqueLines(
        allowedTools.filter(
          (tool) => !["Read", "Grep", "Glob", "Write", "Edit", "MultiEdit"].includes(tool)
        )
      ),
      denied: uniqueLines(deniedTools),
      held: uniqueLines(heldTools),
    },
    bash: {
      allowAll: allowAllBash,
      broadExceptDenied: broadBashExceptDenied,
      allowedPrograms: uniqueLines(allowedPrograms),
      deniedPrograms: uniqueLines(deniedPrograms),
      removeExplicitForbid,
    },
    riskWarnings: uniqueLines(riskWarnings),
    ambiguities: uniqueLines(ambiguities),
  };
}

function inferComplexDraft(raw, state) {
  const lower = raw.toLowerCase();
  const ast = buildPolicyIntentAst(raw);
  const currentPolicy = isPlainObject(state?.policy)
    ? normalizePolicyIr(state.policy)
    : emptyPolicy();
  const additivePolicy = maybeBuildAdditivePolicy(raw, ast, currentPolicy);
  if (additivePolicy) {
    const ambiguities = [...ast.ambiguities];
    ambiguities.push(
      "Additive draft: active policy statements not mentioned in the request were preserved."
    );
    if (ast.bash.allowedPrograms.length) {
      ambiguities.push(`Allowed Bash program change: ${ast.bash.allowedPrograms.join(", ")}.`);
    }
    if (ast.bash.deniedPrograms.length) {
      ambiguities.push(`Denied Bash program change: ${ast.bash.deniedPrograms.join(", ")}.`);
    }
    return {
      draftId: draftId(),
      createdAt: new Date().toISOString(),
      source: { type: "additive_complex_nl_draft", input: raw },
      policy: additivePolicy,
      ast,
      confidence: ast.confidence,
      riskWarnings: draftRiskWarnings(ast.riskWarnings, additivePolicy),
      ambiguities: uniqueLines(ambiguities),
      diff: formatPolicyReviewDiff(currentPolicy, additivePolicy),
      policyHash: canonicalPolicyHash(additivePolicy),
    };
  }
  const name = ast.profileName;
  const wantsWriteTools = ast.fileTools.some((tool) =>
    ["Write", "Edit", "MultiEdit"].includes(tool)
  );
  const broadBashExceptDenied = ast.bash.broadExceptDenied;
  const allowAllBash = ast.bash.allowAll;
  const removeExplicitForbid = ast.bash.removeExplicitForbid;
  const programs = ast.bash.allowedPrograms;
  const denied = ast.bash.deniedPrograms;
  const bashHasExceptions =
    denied.length > 0 && (broadBashExceptDenied || /\b(?:except|expect)\b/i.test(raw));
  const allowUnrestrictedBash = allowAllBash && !bashHasExceptions;
  const allowedTools = ast.tools?.allowed || [];
  const deniedTools = ast.tools?.denied || [];
  const heldTools = ast.tools?.held || [];
  const fileTools = uniqueLines([...ast.fileTools, ...allowedTools]);
  const statements = [
    {
      id: wantsWriteTools ? "allow-file-tools" : "allow-read-tools",
      effect: "permit",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", in: fileTools },
      resource: { type: "workspace", scope: "current" },
      conditions: [],
    },
  ];
  if (deniedTools.length) {
    statements.push({
      id: "forbid-tools",
      effect: "forbid",
      principal: { type: "agent", id: "claude-code" },
      action:
        deniedTools.length === 1
          ? { type: "tool", eq: deniedTools[0] }
          : { type: "tool", in: deniedTools },
      resource: { type: "workspace", scope: "current" },
      conditions: [],
    });
  }
  if (heldTools.length) {
    statements.push({
      id: "hold-tools",
      effect: "require_approval",
      principal: { type: "agent", id: "claude-code" },
      action:
        heldTools.length === 1
          ? { type: "tool", eq: heldTools[0] }
          : { type: "tool", in: heldTools },
      resource: { type: "workspace", scope: "current" },
      conditions: [],
    });
  }
  if (allowUnrestrictedBash) {
    statements.push({
      id: "allow-all-bash",
      effect: "permit",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [],
    });
  } else if ((allowAllBash || broadBashExceptDenied) && denied.length) {
    statements.push({
      id: "allow-bash-except-denied-programs",
      effect: "permit",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [{ field: "bash.program", op: "not_in", value: denied }],
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
        { field: "bash.hasWriteRedirection", op: "eq", value: false },
      ],
    });
  }
  if (denied.length && !removeExplicitForbid) {
    statements.push({
      id: "forbid-cloud-db-admin",
      effect: "forbid",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "Bash" },
      resource: { type: "workspace", scope: "current" },
      conditions: [{ field: "bash.program", op: "in", value: denied }],
    });
  }
  const policy = normalizePolicyIr({
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name, description: `Drafted from: ${raw}` },
    defaults: { decision: ast.defaults.decision, conflictResolution: "deny_overrides" },
    statements,
  });
  const ambiguities = [...ast.ambiguities];
  if (allowUnrestrictedBash) {
    ambiguities.push(
      "All Bash commands are allowed. This is powerful and should only be staged for trusted workspaces."
    );
  }
  if ((allowAllBash || broadBashExceptDenied) && denied.length) {
    ambiguities.push(
      `Bash is broadly allowed except ${denied.join(", ")}. Review carefully before staging.`
    );
  }
  if (allowedTools.length) {
    ambiguities.push(`Claude tool allow change: ${allowedTools.join(", ")}.`);
  }
  if (deniedTools.length) {
    ambiguities.push(`Claude tool block change: ${deniedTools.join(", ")}.`);
  }
  if (heldTools.length) {
    ambiguities.push(`Claude tool approval change: ${heldTools.join(", ")}.`);
  }
  if (removeExplicitForbid && denied.length) {
    ambiguities.push(
      "Explicit forbid statement was omitted because the prompt asked to remove it; denied programs are only excluded from the Bash allow condition."
    );
  }
  if (wantsWriteTools) {
    ambiguities.push(
      "Write/Edit/MultiEdit are included because the prompt mentioned writing or editing files."
    );
  }
  if (lower.includes("curl"))
    ambiguities.push("curl can access external network. Scope all URLs or selected domains?");
  if (lower.includes("file") && !wantsWriteTools)
    ambiguities.push(
      "file access could mean read-only or write access. This draft allows read-oriented tools only."
    );
  if (!ambiguities.length)
    ambiguities.push(
      "This was too complex for deterministic staging; review the normalized JSON before staging."
    );
  return {
    draftId: draftId(),
    createdAt: new Date().toISOString(),
    source: { type: "llm_or_complex_nl_draft", input: raw },
    policy,
    ast,
    confidence: ast.confidence,
    riskWarnings: draftRiskWarnings(ast.riskWarnings, policy),
    ambiguities: uniqueLines(ambiguities),
    diff: formatPolicyReviewDiff(currentPolicy, policy),
    policyHash: canonicalPolicyHash(policy),
  };
}

function canonicalCommandText(prompt) {
  const trimmed = typeof prompt === "string" ? prompt.trim() : "";
  if (!trimmed) return null;

  let match = trimmed.match(/^\/armorclaude:armor(?:\s+([\s\S]*))?$/i);
  if (!match) match = trimmed.match(/^\/armor(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  let rest = (match[1] || "").trim();
  if (/^policy\b/i.test(rest)) {
    rest = rest.replace(/^policy\b\s*/i, "").trim();
  }
  return {
    rest,
    alias: match[0].toLowerCase().startsWith("/armorclaude:armor")
      ? "/armorclaude:armor"
      : "/armor",
  };
}

function parseCommand(prompt) {
  const canonical = canonicalCommandText(prompt);
  if (!canonical) return null;

  const rest = canonical.rest;
  const lower = rest.toLowerCase();

  if (!rest || lower === "help") return { cmd: "help" };
  if (["yes", "y", "approve", "ok"].includes(lower)) {
    return { cmd: "confirm", proposalId: "", saveAs: "" };
  }
  if (["no", "n", "reject", "deny"].includes(lower)) {
    return { cmd: "cancel", proposalId: "" };
  }
  if (lower === "list") return { cmd: "list" };
  if (lower === "view") return { cmd: "view" };
  if (lower === "reset") return { cmd: "reset" };
  if (lower === "export") return { cmd: "export" };
  if (["rebind", "refresh-token", "repair-token"].includes(lower)) {
    return { cmd: "rebind" };
  }

  const defaultMatch = rest.match(/^default\s+(\S+)$/i);
  if (defaultMatch) {
    const decision = normalizeDefaultDecision(defaultMatch[1]);
    return decision
      ? { cmd: "default", decision }
      : { cmd: "default-error", value: defaultMatch[1] };
  }
  if (lower.startsWith("default ")) return { cmd: "default-error", value: rest.slice(8).trim() };

  const stageMatch = rest.match(/^stage\s+([\s\S]+)$/i);
  if (stageMatch) return { cmd: "stage", value: stageMatch[1].trim() };

  const draftValidateMatch = rest.match(/^draft\s+validate\s+([\s\S]+)$/i);
  if (draftValidateMatch) return { cmd: "draft-validate", value: draftValidateMatch[1].trim() };

  const draftEditMatch = rest.match(/^draft\s+edit\s+(draft_[A-Za-z0-9_-]+)\s+([\s\S]+)$/i);
  if (draftEditMatch)
    return { cmd: "draft-edit", draftId: draftEditMatch[1], value: draftEditMatch[2].trim() };

  const reviseMatch = rest.match(/^revise\s+(draft_[A-Za-z0-9_-]+)\s+([\s\S]+)$/i);
  if (reviseMatch)
    return { cmd: "revise", draftId: reviseMatch[1], instruction: reviseMatch[2].trim() };

  const confirmMatch = rest.match(/^confirm(?:\s+(\S+))?(?:\s+save\s+(\S+))?$/i);
  if (confirmMatch) {
    return { cmd: "confirm", proposalId: confirmMatch[1] || "", saveAs: confirmMatch[2] || "" };
  }

  const cancelMatch = rest.match(/^cancel(?:\s+(\S+))?$/i);
  if (cancelMatch) return { cmd: "cancel", proposalId: cancelMatch[1] || "" };

  const addMatch = rest.match(/^add\s+(allow|deny|hold|require_approval)\s+(.+)/i);
  if (addMatch) {
    if (looksComplexNaturalLanguage(rest)) return { cmd: "draft-complex", raw: rest };
    const action =
      addMatch[1].toLowerCase() === "hold" ? "require_approval" : addMatch[1].toLowerCase();
    const rules = parseNaturalRules(rest);
    const classification = classifyParsedRules(rules, rest);
    if (classification === "draft") return { cmd: "draft-complex", raw: rest };
    if (classification === "unsupported") return { cmd: "parse-error", raw: rest };
    if (rules.length > 1) return { cmd: "add-many", rules, raw: rest };
    return { cmd: "add", action, tool: addMatch[2].trim() };
  }
  if (lower.startsWith("add ")) {
    if (looksComplexNaturalLanguage(rest)) return { cmd: "draft-complex", raw: rest };
    const rules = parseNaturalRules(rest);
    const classification = classifyParsedRules(rules, rest);
    if (classification === "draft") return { cmd: "draft-complex", raw: rest };
    if (classification === "unsupported") return { cmd: "parse-error", raw: rest };
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
  const aliases = new Map([...TOOL_ALIASES]);
  return aliases.get(cleaned.toLowerCase()) || cleaned;
}

function splitToolList(rawTools) {
  return rawTools
    .replace(/\b(to use|using|for|tools?|commands?)\b/gi, " ")
    .split(/\s*(?:,|\band\b|[&+])\s*/i)
    .map(normalizeToolLabel)
    .filter(Boolean);
}

function classifyParsedRules(rules, raw) {
  const lower = typeof raw === "string" ? raw.toLowerCase() : "";
  const bashContext =
    /\b(through bash|using bash|bash command|bash program|shell command|terminal command)\b/i.test(
      lower
    );
  for (const rule of rules) {
    const tool = rule.tool;
    const lowerTool = String(tool || "").toLowerCase();
    if (!KNOWN_CLAUDE_TOOLS.has(tool)) {
      if (KNOWN_BASH_PROGRAMS.has(lowerTool)) return "draft";
      return "unsupported";
    }
    if (bashContext && KNOWN_BASH_PROGRAMS.has(lowerTool)) return "draft";
  }
  return "ok";
}

function phraseMentionsBashProgram(text) {
  const lower = typeof text === "string" ? text.toLowerCase() : "";
  return [...KNOWN_BASH_PROGRAMS].some((program) =>
    new RegExp(`\\b${program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower)
  );
}

function looksComplexNaturalLanguage(text) {
  const lower = text.toLowerCase();
  return (
    /["']|only allow|should|policy should|save (this )?as|port access|port checks|file access|file tools|read\/write|network access|internal domains|safe commands|admin tools|except|bash but not|default allow|default deny|default hold|default ask|allow all bash|through bash|using bash|curl|psql|gcloud|kubectl|aws|az/.test(
      lower
    ) &&
    !/^add\s+(allow|deny|hold|require_approval)\s+(read|grep|glob|write|edit|multiedit|bash|webfetch|websearch|explore|agent|skill|toolsearch|lsp|notebookedit|notebookread|powershell|workflow)(\s*(,|\band\b|[&+])\s*(read|grep|glob|write|edit|multiedit|bash|webfetch|websearch|explore|agent|skill|toolsearch|lsp|notebookedit|notebookread|powershell|workflow))*$/i.test(
      text
    ) &&
    (phraseMentionsBashProgram(text) ||
      /["']|only allow|should|policy should|save (this )?as|port access|port checks|file access|file tools|read\/write|network access|internal domains|safe commands|admin tools|except|bash but not|default allow|default deny|default hold|default ask|allow all bash|through bash|using bash/.test(
        lower
      ))
  );
}

export function parseNaturalRules(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return [];
  const body = raw.replace(/^add\b/i, "").trim();
  const actionPattern =
    "(?:allow|deny|block|hold|require_approval|require\\s+approval|ask\\s+before)";
  const regex = new RegExp(
    `\\b(${actionPattern})\\b\\s+([\\s\\S]*?)(?=\\s*(?:[,;]\\s*)?\\b${actionPattern}\\b\\s+|$)`,
    "gi"
  );
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
    "  /armorclaude:armor                              — show this help",
    "  /armorclaude:armor policy list                  — show current rules",
    "  /armorclaude:armor policy view                  — show active policy JSON",
    "  /armorclaude:armor policy default <allow|deny|hold> — stage unmatched-tool default",
    "  /armorclaude:armor policy add allow Read and Grep, deny Write, hold Bash",
    "  /armorclaude:armor policy stage <draft-id|json> — stage validated draft or JSON",
    '  /armorclaude:armor policy revise <draft-id> "remove <statement-id>"',
    "  /armorclaude:armor policy draft edit <draft-id> <json> — replace draft JSON after validation",
    "  /armorclaude:armor policy draft validate <json> — validate pasted policy JSON as a new draft",
    "  /armorclaude:armor policy rebind                 — reissue crypto binding for current policy",
    "  /armorclaude:armor policy remove <rule-id>       — propose removing a rule",
    "  /armorclaude:armor policy reset                  — propose clearing all rules",
    "  /armorclaude:armor policy template <name>        — propose applying a template",
    "  /armorclaude:armor policy confirm [proposal-id]  — apply staged change",
    "  /armorclaude:armor policy cancel [proposal-id]   — discard staged change",
    "  /armorclaude:armor yes                           — apply current staged change",
    "  /armorclaude:armor no                            — discard current staged change",
    "  /armorclaude:armor policy export                 — dump policy as JSON",
    "",
    "  /armorclaude:armor mcp list                     — show detected MCPs",
    "  /armorclaude:armor mcp approve <server>         — approve an MCP server",
    "  /armorclaude:armor mcp deny <server>            — deny an MCP server",
    "",
    "  /armorclaude:armor profile save <name>          — save current policy as profile",
    "  /armorclaude:armor profile list                 — show saved profiles",
    "  /armorclaude:armor profile switch <name>        — switch to a saved profile",
    "  /armorclaude:armor profile delete <name>        — delete a profile",
    "",
    "  Use /armorclaude:armor only; legacy /armor-policy is intentionally unsupported.",
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
        "Try: /armorclaude:armor policy add allow Read and Grep, deny Write, hold Bash",
      ].join("\n");

    case "default-error":
      return [
        "Unknown default decision. No policy was staged.",
        "Use: /armorclaude:armor policy default allow",
        "Use: /armorclaude:armor policy default deny",
        "Use: /armorclaude:armor policy default hold",
      ].join("\n");

    case "draft-complex": {
      const state = await loadPolicyState(config.policyFile);
      const draft = await saveDraft(config, inferComplexDraft(parsed.raw, state));
      return formatDraft(draft);
    }

    case "draft-validate": {
      const parsedJson = extractJson(parsed.value);
      if (!parsedJson) return "Draft validation failed: input is not valid JSON.";
      const result = validateDraftPolicyJson(parsedJson);
      if (!result.ok) {
        return `Draft validation failed:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
      }
      const state = await loadPolicyState(config.policyFile);
      const draft = await saveDraft(config, {
        draftId: draftId(),
        createdAt: new Date().toISOString(),
        source: { type: "llm_draft", input: "pasted-json" },
        policy: result.policy,
        confidence: "schema_validated",
        riskWarnings: riskWarningsForPolicy(result.policy),
        ambiguities: ["LLM/pasted draft validated structurally. Review intent before staging."],
        diff: formatPolicyReviewDiff(state.policy, result.policy),
        policyHash: canonicalPolicyHash(result.policy),
      });
      return formatDraft(draft);
    }

    case "draft-edit": {
      const existing = await loadDraft(config, parsed.draftId);
      if (!existing) return `Draft not found: ${parsed.draftId}`;
      const parsedJson = extractJson(parsed.value);
      if (!parsedJson) return "Draft edit failed: replacement is not valid JSON.";
      const result = validateDraftPolicyJson(parsedJson);
      if (!result.ok) {
        return `Draft edit failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
      }
      const state = await loadPolicyState(config.policyFile);
      const draft = await saveDraft(config, {
        draftId: draftId(),
        createdAt: new Date().toISOString(),
        source: {
          type: "manual_json_draft_edit",
          input: "pasted-json",
          previousDraftId: existing.draftId,
        },
        policy: result.policy,
        confidence: "schema_validated",
        riskWarnings: riskWarningsForPolicy(result.policy),
        ambiguities: ["Manual JSON edit validated structurally. Review intent before staging."],
        diff: formatPolicyReviewDiff(state.policy, result.policy),
        policyHash: canonicalPolicyHash(result.policy),
      });
      return formatDraftRevision({
        original: existing,
        revised: draft,
        removedIds: [],
        note: "Manual JSON replacement validated. No active policy changed.",
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
          previousDraftId: existing.draftId,
        },
        policy: revised.policy,
        confidence: "exact",
        riskWarnings: riskWarningsForPolicy(revised.policy),
        ambiguities: [
          "Draft was revised deterministically. Review the normalized JSON before staging.",
        ],
        policyHash: canonicalPolicyHash(revised.policy),
      });
      return formatDraftRevision({
        original: existing,
        revised: draft,
        removedIds: revised.removedIds || [],
        note: "No active policy changed.",
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
        const result = validateDraftPolicyJson(parsedJson);
        if (!result.ok) {
          return `Stage failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
        }
        policy = result.policy;
      }
      const proposedPolicy = normalizePolicyIr(policy);
      const pending = await stagePending(
        config,
        state,
        proposedPolicy,
        `stage ${draft?.draftId || "pasted policy"}`,
        {
          type: draft ? "llm_draft_stage" : "pasted_json_stage",
        }
      );
      return formatProposal(
        pending,
        state.policy,
        proposedPolicy,
        "Staged validated policy draft:"
      );
    }

    case "list": {
      const state = await loadPolicyState(config.policyFile);
      const review = summarizePolicyReview(state.policy);
      if (review === "(no statements)") {
        return [
          `Policy v${state.version}: no rules configured.`,
          defaultDecisionText(state.policy),
          "Use /armorclaude:armor policy add, /armorclaude:armor policy default, or /armorclaude:armor policy template to get started.",
        ].join("\n");
      }
      return [
        `Policy v${state.version}:`,
        `  ${defaultDecisionText(state.policy)}`,
        review
          .split("\n")
          .map((line, index) => `  ${index + 1}. ${line}`)
          .join("\n"),
      ].join("\n");
    }

    case "view": {
      const state = await loadPolicyState(config.policyFile);
      return JSON.stringify(state.policy, null, 2);
    }

    case "export": {
      const state = await loadPolicyState(config.policyFile);
      return JSON.stringify(state, null, 2);
    }

    case "rebind": {
      if (!config.cryptoPolicyEnabled) {
        return "Crypto policy binding is disabled for this setup.";
      }
      const state = await loadPolicyState(config.policyFile);
      const result = await issueCryptoPolicyTokenForState(config, state);
      if (!result.ok) {
        return `Crypto policy rebind failed. Active policy was not changed. Reason: ${result.error}`;
      }
      return `Crypto policy rebound for policy v${state.version}.${result.note}`;
    }

    case "default": {
      const state = await loadPolicyState(config.policyFile);
      const proposedPolicy = withDefaultDecision(state.policy, parsed.decision);
      const pending = await stagePending(
        config,
        state,
        proposedPolicy,
        `default ${parsed.decision}`,
        { type: "deterministic" }
      );
      const behavior = {
        allow: "unmatched tools will be allowed",
        deny: "unmatched tools will be blocked",
        hold: "unmatched tools will ask for approval",
      }[parsed.decision];
      return formatProposal(
        pending,
        state.policy,
        proposedPolicy,
        `Proposed: set default policy decision to ${parsed.decision} (${behavior}).`
      );
    }

    case "add": {
      const state = await loadPolicyState(config.policyFile);
      const id = nextPolicyId(state.policy);
      const newRule = { id, action: parsed.action, tool: parsed.tool };
      const proposedPolicy = appendRuleToPolicy(state.policy, newRule);
      const pending = await stagePending(
        config,
        state,
        proposedPolicy,
        `add ${parsed.action} ${parsed.tool}`,
        { type: "deterministic" }
      );
      return formatProposal(pending, state.policy, proposedPolicy);
    }

    case "add-many": {
      const state = await loadPolicyState(config.policyFile);
      let proposedPolicy = state.policy;
      for (const rule of parsed.rules) {
        const id = nextPolicyId(proposedPolicy);
        const nextRule = { id, action: rule.action, tool: rule.tool };
        proposedPolicy = appendRuleToPolicy(proposedPolicy, nextRule);
      }
      const pending = await stagePending(config, state, proposedPolicy, parsed.raw, {
        type: "deterministic",
      });
      return formatProposal(pending, state.policy, proposedPolicy, "Proposed policy changes:");
    }

    case "remove": {
      const state = await loadPolicyState(config.policyFile);
      const exists = normalizePolicyIr(state.policy).statements.find(
        (statement) => statement.id === parsed.id
      );
      if (!exists) return `Rule not found: ${parsed.id}`;
      const proposedPolicy = removeStatementFromPolicy(state.policy, parsed.id);
      const pending = await stagePending(config, state, proposedPolicy, `remove ${parsed.id}`, {
        type: "deterministic",
      });
      return formatProposal(pending, state.policy, proposedPolicy);
    }

    case "reset": {
      const state = await loadPolicyState(config.policyFile);
      const proposedPolicy = emptyPolicy(state.policy?.metadata?.name || "current");
      const pending = await stagePending(config, state, proposedPolicy, "reset policy statements", {
        type: "deterministic",
      });
      return [
        "Proposed: reset active policy to an empty default-deny policy.",
        formatPolicyReviewDiff(state.policy, proposedPolicy),
        "",
        "Next:",
        `  /armorclaude:armor yes                         apply ${pending.proposalId}`,
        `  /armorclaude:armor no                          discard ${pending.proposalId}`,
        `  /armorclaude:armor policy confirm ${pending.proposalId}`,
        `  /armorclaude:armor policy cancel ${pending.proposalId}`,
      ].join("\n");
    }

    case "template": {
      const tmpl = getTemplate(parsed.name);
      if (!tmpl) {
        return `Unknown template: ${parsed.name}\nAvailable: ${getTemplateNames().join(", ")}`;
      }
      const state = await loadPolicyState(config.policyFile);
      const proposedPolicy = normalizePolicyIr(tmpl.policy);
      const pending = await stagePending(config, state, proposedPolicy, `template ${parsed.name}`, {
        type: "deterministic",
      });
      return formatProposal(
        pending,
        state.policy,
        proposedPolicy,
        `Proposed: apply template "${tmpl.name}" — ${tmpl.description}`
      );
    }

    case "confirm": {
      const pending = await readJson(pendingPath(config), null);
      if (!pending)
        return "Nothing staged. Use /armorclaude:armor policy add, remove, reset, or template first.";
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
      if (pending.basePolicyHash && pending.basePolicyHash !== canonicalPolicyHash(state.policy)) {
        return "Policy changed since proposal was staged. Please review and stage again.";
      }
      if (!pending.proposedPolicy || pending.proposalHash !== hashJson(pending.proposedPolicy)) {
        return "Staged policy proposal hash mismatch. Refusing to apply.";
      }
      const proposedPolicy = normalizePolicyIr(pending.proposedPolicy);
      const nextState = {
        version: state.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: "user",
        policy: proposedPolicy,
        history: [
          ...state.history,
          {
            version: state.version + 1,
            updatedAt: new Date().toISOString(),
            updatedBy: "user",
            reason: pending.reason,
            proposalId: pending.proposalId,
            policy: proposedPolicy,
          },
        ],
      };
      let profileNote = "";
      let cryptoNote = "";
      const cryptoResult = await issueCryptoPolicyTokenForState(config, nextState);
      if (!cryptoResult.ok) {
        if (canApplyFailClosedWhenCryptoFails(pending, proposedPolicy)) {
          await savePolicyState(config.policyFile, nextState);
          await clearPending(config);
          await clearCryptoPolicyToken(config);
          return [
            `Policy updated to v${nextState.version}. ${pending.reason}`,
            "Crypto policy token issuance failed, so the cached token was cleared.",
            "Active policy is now empty default-deny; tool execution will fail closed until /armorclaude:armor policy rebind succeeds.",
            `Reason: ${cryptoResult.error}`,
          ].join("\n");
        }
        return `Policy update blocked: crypto policy token issuance failed, so the active policy was not changed. Reason: ${cryptoResult.error}`;
      }
      cryptoNote = cryptoResult.note;

      await savePolicyState(config.policyFile, nextState);
      if (parsed.saveAs) {
        const saved = await saveProfile(config, parsed.saveAs, "", nextState.policy);
        profileNote = ` Profile "${parsed.saveAs}" saved (v${saved.version}).`;
      }
      await clearPending(config);

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
      const lines = servers.map((s) => `  ${s.serverName} — ${s.status}`);
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
      const lines = profiles.map(
        (p) =>
          `  ${p.profile.name} — ${p.profile.description || "(no description)"} (v${p.version}, ${p.profile.createdBy})`
      );
      return `Saved profiles (${profiles.length}):\n${lines.join("\n")}`;
    }

    case "profile-save": {
      const state = await loadPolicyState(config.policyFile);
      const statementCount = normalizePolicyIr(state.policy).statements.length;
      if (!statementCount) {
        return "Cannot save empty policy as profile. Add rules first.";
      }
      const saved = await saveProfile(config, parsed.name, "", state.policy);
      return `Profile "${parsed.name}" saved (v${saved.version}, ${statementCount} statements).`;
    }

    case "profile-switch": {
      const profile = await loadProfile(config, parsed.name);
      if (!profile) {
        const profiles = await listProfiles(config);
        const names = profiles.map((p) => p.profile.name).join(", ");
        return `Profile not found: ${parsed.name}\nAvailable: ${names || "(none)"}`;
      }
      const state = await loadPolicyState(config.policyFile);
      const profilePolicy = normalizePolicyIr(profile.policy);
      const pending = await stagePending(
        config,
        state,
        profilePolicy,
        `switch to profile "${parsed.name}"`,
        { type: "deterministic" }
      );
      return formatProposal(
        pending,
        state.policy,
        profilePolicy,
        `Proposed: switch to profile "${profile.profile.name}" — ${profile.profile.description || "(no description)"}`
      );
    }

    case "profile-delete": {
      const deleted = await deleteProfile(config, parsed.name);
      if (!deleted) return `Profile not found: ${parsed.name}`;
      return `Profile "${parsed.name}" deleted.`;
    }

    case "profile-push": {
      if (!config.apiKey)
        return "Profile push requires an API key. Set ARMORIQ_API_KEY or configure credentials.";
      const profile = await loadProfile(config, parsed.name);
      if (!profile) return `Profile not found: ${parsed.name}`;
      const result = await pushProfileToBackend(config, profile);
      if (!result.ok)
        return `Failed to push profile "${parsed.name}": ${result.reason || `HTTP ${result.status}`}`;
      return `Profile "${parsed.name}" pushed to organization.`;
    }

    case "profile-pull": {
      if (!config.apiKey)
        return "Profile pull requires an API key. Set ARMORIQ_API_KEY or configure credentials.";
      const result = await pullProfilesFromBackend(config);
      if (!result.ok) return `Failed to pull profiles: ${result.reason || `HTTP ${result.status}`}`;
      if (!result.profiles.length) return "No org profiles found on backend.";
      let saved = 0;
      for (const p of result.profiles) {
        if (p?.profile?.name && p?.policy) {
          await saveProfile(config, p.profile.name, p.profile.description || "", p.policy);
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
          "  /armorclaude:armor settings enforcement <local|opa>  — switch enforcement engine",
        ].join("\n");
      }
      const enfMatch = settingsRest.match(/^enforcement\s+(local|opa)$/);
      if (enfMatch) {
        const engine = enfMatch[1];
        if (engine === "opa" && !config.opaPdpUrl) {
          return "Cannot switch to OPA: ARMORCLAUDE_OPA_PDP_URL is not configured.";
        }
        return (
          `Enforcement engine set to "${engine}". Restart session to apply.\n` +
          `Note: Set ARMORCLAUDE_ENFORCEMENT_ENGINE=${engine} in your environment to persist.`
        );
      }
      return "Unknown setting. Use: /armorclaude:armor settings enforcement <local|opa>";
    }

    case "sync": {
      if (!config.apiKey)
        return "Sync requires an API key. Set ARMORIQ_API_KEY or configure credentials.";
      const state = await loadPolicyState(config.policyFile);
      const result = await syncPolicyToBackend(config, state);
      if (!result.ok) return `Sync failed: ${result.reason || `HTTP ${result.status}`}`;
      return `Policy v${state.version} synced to backend.`;
    }

    default:
      return helpText();
  }
}

async function stagePending(
  config,
  state,
  proposedPolicy,
  reason,
  source = { type: "deterministic" }
) {
  const policy = normalizePolicyIr(proposedPolicy);
  const patch = jsonPatchForPolicy(state.policy, policy);
  const pending = {
    proposalId: proposalId(),
    stagedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(),
    baseVersion: Number.isFinite(state.version) ? state.version : 0,
    basePolicyHash: canonicalPolicyHash(state.policy),
    reason,
    source,
    proposedPolicy: policy,
    patch,
    proposalHash: hashJson(policy),
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
