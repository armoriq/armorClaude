import { createHash } from "node:crypto";
import path from "node:path";
import { isPlainObject, normalizeToolName } from "./common.mjs";

export const POLICY_IR_VERSION = "armor.policy.v1";

const EFFECTS = new Set(["permit", "forbid", "require_approval"]);
const DEFAULT_DECISIONS = new Set(["allow", "deny", "hold"]);
const CONFLICT_RESOLUTIONS = new Set(["deny_overrides"]);
const PRINCIPAL_TYPES = new Set(["agent", "user", "org", "role"]);
const ACTION_TYPES = new Set(["tool", "mcp_server", "mcp_tool", "bash_program"]);
const RESOURCE_TYPES = new Set(["workspace", "file", "directory", "network", "mcp_server", "secret"]);
const CONDITION_FIELDS = new Set([
  "tool.name",
  "bash.program",
  "bash.raw",
  "bash.hasWriteRedirection",
  "file.path",
  "network.host",
  "mcp.server"
]);
const CONDITION_OPS = new Set([
  "eq",
  "in",
  "not_in",
  "matches",
  "not_matches",
  "starts_with",
  "within_workspace"
]);
const KNOWN_TOOLS = new Set([
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
  "Write"
]);
const LEGACY_BASH_PROGRAMS = new Set([
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
  "az"
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== "rules")
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function extraKeys(obj, allowed) {
  return Object.keys(obj).filter((key) => !allowed.includes(key));
}

function actionValue(action) {
  if (!isPlainObject(action)) return [];
  if (typeof action.eq === "string") return [action.eq];
  if (Array.isArray(action.in)) return action.in.filter((entry) => typeof entry === "string");
  return [];
}

function selectorForValues(values) {
  const clean = values.filter((value) => typeof value === "string" && value.trim());
  if (clean.length === 1) return { type: "tool", eq: clean[0] };
  return { type: "tool", in: clean };
}

function safeToolSuffix(tool) {
  return String(tool).replace(/[^A-Za-z0-9_-]/g, "_");
}

function normalizeLegacyAction(action) {
  if (action === "deny") return "forbid";
  if (action === "require_approval") return "require_approval";
  return "permit";
}

export function legacyRulesToPolicyIr(rules = [], metadata = {}, defaults = {}) {
  const statements = (Array.isArray(rules) ? rules : []).map((rule, idx) => {
    const tool = typeof rule.tool === "string" && rule.tool ? rule.tool : "*";
    const effect = normalizeLegacyAction(rule.action);
    const program = tool.trim().toLowerCase();
    const isBashProgram = isLegacyBashProgramTool(tool);
    return {
      id: typeof rule.id === "string" && rule.id ? rule.id : `policy${idx + 1}`,
      effect,
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: isBashProgram ? "Bash" : tool },
      resource: { type: "workspace", scope: "current" },
      conditions: isBashProgram
        ? [
            { field: "bash.program", op: "in", value: [program] },
            ...(effect === "permit"
              ? [{ field: "bash.hasWriteRedirection", op: "eq", value: false }]
              : [])
          ]
        : []
    };
  });
  return normalizePolicyIr({
    schemaVersion: POLICY_IR_VERSION,
    kind: "PolicyProfile",
    metadata: {
      name: metadata.name || "current",
      description: metadata.description || ""
    },
    defaults: {
      decision: defaults.decision || "allow",
      conflictResolution: "deny_overrides"
    },
    statements
  });
}

export function normalizePolicyIr(policyLike) {
  if (isPlainObject(policyLike) && policyLike.schemaVersion === POLICY_IR_VERSION) {
    const metadata = isPlainObject(policyLike.metadata) ? policyLike.metadata : {};
    const defaults = isPlainObject(policyLike.defaults) ? policyLike.defaults : {};
    const statements = Array.isArray(policyLike.statements) ? policyLike.statements : [];
    return {
      schemaVersion: POLICY_IR_VERSION,
      kind: "PolicyProfile",
      metadata: {
        name: typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : "current",
        description: typeof metadata.description === "string" ? metadata.description : ""
      },
      defaults: {
        decision: DEFAULT_DECISIONS.has(defaults.decision) ? defaults.decision : "deny",
        conflictResolution: "deny_overrides"
      },
      statements: compactPolicyStatements(statements.flatMap((statement, idx) => normalizeStatementGroup(statement, idx)))
    };
  }
  const legacyRules = Array.isArray(policyLike?.rules) ? policyLike.rules : [];
  return legacyRulesToPolicyIr(legacyRules);
}

function isLegacyBashProgramTool(value) {
  return !KNOWN_TOOLS.has(value) && LEGACY_BASH_PROGRAMS.has(normalizeToolName(value));
}

function hasCondition(conditions, field, op) {
  return conditions.some((condition) => condition?.field === field && condition?.op === op);
}

function normalizeStatementGroup(statement, idx) {
  const normalized = normalizeStatement(statement, idx);
  if (normalized.action.type !== "tool") return [normalized];
  const values = actionValue(normalized.action);
  const bashPrograms = values.filter(isLegacyBashProgramTool).map((value) => normalizeToolName(value));
  if (!bashPrograms.length) return [normalized];

  const toolValues = values.filter((value) => !isLegacyBashProgramTool(value));
  const repairedBash = {
    ...normalized,
    id: toolValues.length ? `${normalized.id}-bash-programs` : normalized.id,
    action: { type: "tool", eq: "Bash" },
    conditions: [
      ...normalized.conditions,
      { field: "bash.program", op: "in", value: [...new Set(bashPrograms)] },
      ...(normalized.effect === "permit" && !hasCondition(normalized.conditions, "bash.hasWriteRedirection", "eq")
        ? [{ field: "bash.hasWriteRedirection", op: "eq", value: false }]
        : [])
    ]
  };
  if (!toolValues.length) return [repairedBash];
  return [
    {
      ...normalized,
      action: selectorForValues(toolValues)
    },
    repairedBash
  ];
}

function compactKey(statement, baseId) {
  return JSON.stringify({
    id: baseId,
    effect: statement.effect,
    principal: statement.principal,
    resource: statement.resource,
    conditions: statement.conditions
  });
}

function splitToolStatementBase(statement) {
  if (statement.action?.type !== "tool" || typeof statement.action?.eq !== "string") return null;
  const tool = statement.action.eq;
  if (!KNOWN_TOOLS.has(tool) || tool === "*" || tool === "Bash") return null;
  const suffix = `-${safeToolSuffix(tool)}`;
  if (!statement.id.endsWith(suffix)) return null;
  return statement.id.slice(0, -suffix.length);
}

function compactPolicyStatements(statements) {
  const out = [];
  const groups = new Map();
  for (const statement of statements) {
    const baseId = splitToolStatementBase(statement);
    if (!baseId) {
      out.push(statement);
      continue;
    }
    const key = compactKey(statement, baseId);
    let group = groups.get(key);
    if (!group) {
      group = {
        index: out.length,
        baseId,
        statement,
        tools: []
      };
      groups.set(key, group);
      out.push(null);
    }
    group.tools.push(statement.action.eq);
  }
  for (const group of groups.values()) {
    out[group.index] = {
      ...group.statement,
      id: group.baseId,
      action: selectorForValues([...new Set(group.tools)])
    };
  }
  return out.filter(Boolean);
}

function normalizeStatement(statement, idx) {
  const input = isPlainObject(statement) ? statement : {};
  const principal = isPlainObject(input.principal) ? input.principal : {};
  const action = isPlainObject(input.action) ? input.action : {};
  const resource = isPlainObject(input.resource) ? input.resource : {};
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : `statement${idx + 1}`,
    effect: EFFECTS.has(input.effect) ? input.effect : "forbid",
    principal: {
      type: PRINCIPAL_TYPES.has(principal.type) ? principal.type : "agent",
      id: typeof principal.id === "string" && principal.id.trim() ? principal.id.trim() : "claude-code"
    },
    action: normalizeSelector(action, "tool"),
    resource: {
      type: RESOURCE_TYPES.has(resource.type) ? resource.type : "workspace",
      scope: typeof resource.scope === "string" && resource.scope ? resource.scope : "current"
    },
    conditions: Array.isArray(input.conditions)
      ? input.conditions.map(normalizeCondition).filter(Boolean)
      : []
  };
}

function normalizeSelector(selector, fallbackType) {
  const input = isPlainObject(selector) ? selector : {};
  const out = {
    type: ACTION_TYPES.has(input.type) ? input.type : fallbackType
  };
  if (typeof input.eq === "string" && input.eq.trim()) out.eq = input.eq.trim();
  if (Array.isArray(input.in)) out.in = input.in.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
  if (!out.eq && !out.in) out.eq = "*";
  return out;
}

function normalizeCondition(condition) {
  if (!isPlainObject(condition)) return null;
  const field = typeof condition.field === "string" ? condition.field.trim() : "";
  const op = typeof condition.op === "string" ? condition.op.trim() : "";
  if (!CONDITION_FIELDS.has(field) || !CONDITION_OPS.has(op)) return null;
  return {
    field,
    op,
    value: condition.value
  };
}

export function validatePolicyIr(policyLike) {
  const errors = [];
  if (!isPlainObject(policyLike)) {
    return { ok: false, errors: ["Policy must be a JSON object"] };
  }
  const rootExtras = extraKeys(policyLike, ["schemaVersion", "kind", "metadata", "defaults", "statements"]);
  if (rootExtras.length) errors.push(`Unknown policy field(s): ${rootExtras.join(", ")}`);
  if (policyLike.schemaVersion !== POLICY_IR_VERSION) errors.push(`schemaVersion must be ${POLICY_IR_VERSION}`);
  if (policyLike.kind !== "PolicyProfile") errors.push("kind must be PolicyProfile");

  if (!isPlainObject(policyLike.metadata)) errors.push("metadata must be an object");
  if (!isPlainObject(policyLike.defaults)) errors.push("defaults must be an object");
  if (!Array.isArray(policyLike.statements)) errors.push("statements must be an array");

  if (isPlainObject(policyLike.defaults)) {
    const defaultsExtras = extraKeys(policyLike.defaults, ["decision", "conflictResolution"]);
    if (defaultsExtras.length) errors.push(`Unknown defaults field(s): ${defaultsExtras.join(", ")}`);
    if (!DEFAULT_DECISIONS.has(policyLike.defaults.decision)) errors.push("defaults.decision must be allow, deny, or hold");
    if (!CONFLICT_RESOLUTIONS.has(policyLike.defaults.conflictResolution)) errors.push("defaults.conflictResolution must be deny_overrides");
  }

  const seen = new Set();
  if (Array.isArray(policyLike.statements)) {
    policyLike.statements.forEach((statement, idx) => validateStatement(statement, idx, seen, errors));
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, errors: [], policy: normalizePolicyIr(policyLike) };
}

function validateStatement(statement, idx, seen, errors) {
  if (!isPlainObject(statement)) {
    errors.push(`statements[${idx}] must be an object`);
    return;
  }
  const extras = extraKeys(statement, ["id", "effect", "principal", "action", "resource", "conditions"]);
  if (extras.length) errors.push(`statements[${idx}] unknown field(s): ${extras.join(", ")}`);
  if (typeof statement.id !== "string" || !statement.id.trim()) errors.push(`statements[${idx}].id is required`);
  if (seen.has(statement.id)) errors.push(`Duplicate statement id: ${statement.id}`);
  seen.add(statement.id);
  if (!EFFECTS.has(statement.effect)) errors.push(`statements[${idx}].effect is invalid`);
  validatePrincipal(statement.principal, idx, errors);
  validateAction(statement.action, idx, errors);
  validateResource(statement.resource, idx, errors);
  if (!Array.isArray(statement.conditions)) {
    errors.push(`statements[${idx}].conditions must be an array`);
  } else {
    statement.conditions.forEach((condition, cidx) => validateCondition(condition, idx, cidx, errors));
  }
}

function validatePrincipal(principal, idx, errors) {
  if (!isPlainObject(principal)) return errors.push(`statements[${idx}].principal must be an object`);
  const extras = extraKeys(principal, ["type", "id"]);
  if (extras.length) errors.push(`statements[${idx}].principal unknown field(s): ${extras.join(", ")}`);
  if (!PRINCIPAL_TYPES.has(principal.type)) errors.push(`statements[${idx}].principal.type is invalid`);
  if (typeof principal.id !== "string" || !principal.id.trim()) errors.push(`statements[${idx}].principal.id is required`);
}

function validateAction(action, idx, errors) {
  if (!isPlainObject(action)) return errors.push(`statements[${idx}].action must be an object`);
  const extras = extraKeys(action, ["type", "eq", "in"]);
  if (extras.length) errors.push(`statements[${idx}].action unknown field(s): ${extras.join(", ")}`);
  if (!ACTION_TYPES.has(action.type)) errors.push(`statements[${idx}].action.type is invalid`);
  if (!action.eq && !action.in) errors.push(`statements[${idx}].action needs eq or in`);
  const values = actionValue(action);
  if (action.type === "tool") {
    for (const value of values) {
      if (!KNOWN_TOOLS.has(value)) errors.push(`Unknown tool in statements[${idx}]: ${value}`);
    }
  }
}

function validateResource(resource, idx, errors) {
  if (!isPlainObject(resource)) return errors.push(`statements[${idx}].resource must be an object`);
  const extras = extraKeys(resource, ["type", "scope", "path", "host", "name"]);
  if (extras.length) errors.push(`statements[${idx}].resource unknown field(s): ${extras.join(", ")}`);
  if (!RESOURCE_TYPES.has(resource.type)) errors.push(`statements[${idx}].resource.type is invalid`);
}

function validateCondition(condition, idx, cidx, errors) {
  if (!isPlainObject(condition)) return errors.push(`statements[${idx}].conditions[${cidx}] must be an object`);
  const extras = extraKeys(condition, ["field", "op", "value"]);
  if (extras.length) errors.push(`statements[${idx}].conditions[${cidx}] unknown field(s): ${extras.join(", ")}`);
  if (!CONDITION_FIELDS.has(condition.field)) errors.push(`Unknown condition field: ${condition.field}`);
  if (!CONDITION_OPS.has(condition.op)) errors.push(`Unknown condition op: ${condition.op}`);
}

export function canonicalPolicyHash(policyLike) {
  const policy = normalizePolicyIr(policyLike);
  return createHash("sha256").update(JSON.stringify(stable(policy))).digest("hex");
}

export function parseBashCommand(command) {
  const raw = typeof command === "string" ? command.trim() : "";
  const withoutEnv = raw.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
  const program = withoutEnv.split(/\s+/)[0] || "";
  return {
    raw,
    program: program.replace(/^["'`]+|["'`]+$/g, ""),
    hasWriteRedirection: /(^|[^<])>{1,2}|\btee\b|\bsed\s+-i\b|\btruncate\b|\bdd\b/.test(raw)
  };
}

function selectorMatches(selector, actual) {
  const values = actionValue(selector);
  if (values.includes("*")) return true;
  return values.some((value) => normalizeToolName(value) === normalizeToolName(actual));
}

function conditionValue(field, toolName, toolParams = {}) {
  const bash = parseBashCommand(toolParams.command || "");
  if (field === "tool.name") return toolName;
  if (field === "bash.program") return bash.program;
  if (field === "bash.raw") return bash.raw;
  if (field === "bash.hasWriteRedirection") return bash.hasWriteRedirection;
  if (field === "file.path") return toolParams.file_path || toolParams.path || "";
  if (field === "network.host") {
    try {
      const url = toolParams.url || String(toolParams.command || "").match(/https?:\/\/[^\s'"]+/)?.[0] || "";
      return url ? new URL(url).host : "";
    } catch {
      return "";
    }
  }
  if (field === "mcp.server") return String(toolName).split("__")[1] || "";
  return undefined;
}

// Resolve a file path against the workspace root and report whether it lands
// inside that root. Both relative and absolute paths are handled: relative
// paths are resolved against the root, absolute paths are compared directly.
// If the workspace root is unknown we return false (treat as "outside"), which
// is the fail-safe answer — an out-of-workspace write should require approval
// rather than be silently permitted.
function pathWithinWorkspace(filePath, workspaceRoot) {
  if (typeof filePath !== "string" || !filePath) return false;
  if (typeof workspaceRoot !== "string" || !workspaceRoot) return false;
  const root = path.resolve(workspaceRoot);
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function conditionMatches(condition, toolName, toolParams, context = {}) {
  const actual = conditionValue(condition.field, toolName, toolParams);
  const expected = condition.value;
  switch (condition.op) {
    case "eq": return actual === expected;
    case "in": return Array.isArray(expected) && expected.includes(actual);
    case "not_in": return Array.isArray(expected) && !expected.includes(actual);
    case "matches": return typeof expected === "string" && new RegExp(expected).test(String(actual));
    case "not_matches": return typeof expected === "string" && !new RegExp(expected).test(String(actual));
    case "starts_with": return typeof expected === "string" && String(actual).startsWith(expected);
    case "within_workspace": {
      // `value: true`  → condition matches when the path IS inside the workspace
      // `value: false` → condition matches when the path is OUTSIDE the workspace
      // Default to requiring "inside" when no explicit value is given.
      const want = expected === false ? false : true;
      return pathWithinWorkspace(actual, context.workspaceRoot) === want;
    }
    default: return false;
  }
}

function statementMatches(statement, toolName, toolParams, context) {
  if (!selectorMatches(statement.action, toolName)) return false;
  return statement.conditions.every((condition) => conditionMatches(condition, toolName, toolParams, context));
}

// Registry of plain-language explainers for policy conditions, so an approval
// prompt can tell the user *why* it is asking rather than just citing a rule
// id. Each describer receives (condition, actual, ctx) and returns a clause, or
// a falsy value to fall through. Keys are matched most-specific first:
//   1. "<field>:<op>"  (e.g. "file.path:within_workspace")
//   2. "<field>"       (e.g. "bash.program")
// Add a new explanation by adding an entry here, or at runtime via
// registerConditionDescriber() — no need to touch the approval flow itself.
const CONDITION_DESCRIBERS = {
  "file.path:within_workspace": (condition, actual) =>
    condition.value === false
      ? `it writes to a path outside the workspace (${actual || "unknown path"})`
      : `it writes inside the workspace (${actual || "unknown path"})`,
  "file.path": (condition, actual) => `the file path is "${actual}"`,
  "bash.program": (condition, actual) => `it runs "${actual}"`,
  "bash.raw": (condition) => `the command matches a guarded pattern (${condition.value})`,
  "network.host": (condition, actual) => `it contacts host "${actual}"`,
};

// Register (or override) a condition describer. `key` is "<field>" or
// "<field>:<op>". Lets other modules extend approval messaging without editing
// this file.
export function registerConditionDescriber(key, describer) {
  if (typeof key === "string" && typeof describer === "function") {
    CONDITION_DESCRIBERS[key] = describer;
  }
}

// Render a single matched condition as a plain-language clause via the registry,
// falling back to a generic "<field> <op>" description.
function describeCondition(condition, toolName, toolParams) {
  const actual = conditionValue(condition.field, toolName, toolParams);
  const describer =
    CONDITION_DESCRIBERS[`${condition.field}:${condition.op}`] ||
    CONDITION_DESCRIBERS[condition.field];
  if (describer) {
    const text = describer(condition, actual, { toolName, toolParams });
    if (text) return text;
  }
  return `${condition.field} ${condition.op}`;
}

// Build the human-readable reason shown when a statement requires approval.
function explainApproval(statement, toolName, toolParams) {
  const tool = toolName || "this tool";
  const clauses = (statement.conditions || [])
    .map((condition) => describeCondition(condition, toolName, toolParams))
    .filter(Boolean);
  const why = clauses.length ? ` because ${clauses.join(" and ")}` : "";
  return `ArmorClaude needs your approval to run ${tool}${why} (policy rule ${statement.id}).`;
}

export function evaluatePolicyIr({ policy, toolName, toolParams, workspaceRoot }) {
  const normalized = normalizePolicyIr(policy);
  const context = { workspaceRoot: typeof workspaceRoot === "string" ? workspaceRoot : "" };
  const matches = normalized.statements.filter((statement) => statementMatches(statement, toolName, toolParams || {}, context));
  const forbid = matches.find((statement) => statement.effect === "forbid");
  if (forbid) {
    return { allowed: false, reason: `ArmorClaude policy forbid: ${forbid.id}`, matchedRule: forbid };
  }
  const approval = matches.find((statement) => statement.effect === "require_approval");
  if (approval) {
    return { allowed: false, reason: explainApproval(approval, toolName, toolParams), matchedRule: approval };
  }
  const permit = matches.find((statement) => statement.effect === "permit");
  if (permit) {
    return { allowed: true, matchedRule: permit };
  }
  if (normalized.defaults.decision === "allow") {
    return { allowed: true };
  }
  if (normalized.defaults.decision === "hold") {
    return {
      allowed: false,
      reason: `ArmorClaude needs your approval to run ${toolName || "this tool"} because no policy rule explicitly allows it and the default is to hold unmatched actions for review.`,
      matchedRule: {
        id: "default-hold",
        effect: "require_approval",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "*" },
        resource: { type: "workspace", scope: "current" },
        conditions: []
      }
    };
  }
  return {
    allowed: false,
    reason: `ArmorClaude policy default deny: no statement matched tool ${toolName}. Active default is deny.`
  };
}
