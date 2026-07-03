import {
  isPlainObject,
  normalizeToolName,
  nowEpochSeconds,
  redactSecrets,
  sanitizeParams,
} from "./common.mjs";
import {
  addPromptContext,
  armorReply,
  askPreTool,
  blockPrompt,
  denyPreTool,
  denyPreToolWithHint,
} from "./hook-output.mjs";
import {
  isArmorPolicyCommand,
  handleArmorPolicyCommand,
  syncActivePolicyFromBackend,
} from "./armor-policy-commands.mjs";
import { getTemplateNames, getTemplate } from "./policy-templates.mjs";
import {
  checkIntentTokenPlan,
  checkToolAgainstPlan,
  extractAllowedActions,
  findPlanStepIndices,
  getSdkClient,
  getSessionTokenUsedStepIndices,
  parseCsrgProofHeaders,
  recordSessionTokenUsedStepIndices,
  requestIntent,
  resolveCsrgProofsFromToken,
  validateCsrgProofHeaders,
} from "./intent.mjs";
import { createIapService, reanchorViaSdk, revokeViaSdk } from "./iap-service.mjs";
import { computePolicyHash, evaluatePolicy, loadPolicyState } from "./policy.mjs";
import { INTENT_PLAN_FORMAT, INTENT_PLAN_ZOD, normalizeIntentPlan } from "./intent-schema.mjs";
import { extractPlanJsonBlock, parsePlanFile, resolvePlanFilePath } from "./planner.mjs";
import { readJson } from "./fs-store.mjs";
import { mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import {
  appendTrustOp,
  getSession,
  loadRuntimeState,
  saveRuntimeState,
  upsertDiscoveredTool,
  upsertSession,
} from "./runtime-state.mjs";
import { sha256Hex } from "./common.mjs";
import { parseToolIdentity, getMcpServerStatus, setMcpServerStatus } from "./tool-registry.mjs";
import { autoRegisterMcp, syncMcpRegistry } from "./backend-client.mjs";
import { evaluateOpa } from "./opa-client.mjs";
import { compileToOpaInput } from "./policy-compiler.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INTENT_POLICY_COMPILER_VERSION = "sdk-csrg-policy-v1";

function shouldDeny(config) {
  return config.mode === "enforce";
}

function legacyArmorPolicyMessage() {
  return "Legacy /armor-policy is intentionally unsupported. Use /armorclaude:armor policy ... instead.";
}

function mergeIntentIntoSession(session, intentResponse, config) {
  if (!intentResponse || intentResponse.skipped) {
    return session;
  }
  const next = { ...session };
  if (typeof intentResponse.tokenRaw === "string") {
    next.intentTokenRaw = intentResponse.tokenRaw;
  }
  if (intentResponse.plan && typeof intentResponse.plan === "object") {
    next.plan = intentResponse.plan;
    next.allowedActions = Array.from(extractAllowedActions(intentResponse.plan));
  }
  if (Number.isFinite(intentResponse.expiresAt)) {
    next.expiresAt = intentResponse.expiresAt;
  }
  // Stamp the API-key prefix on the session so the next hook can detect
  // a key change and invalidate the cached token automatically. The
  // prefix (first 16 chars) is the same value stored in api_keys.key_prefix
  // and is safe to record — it's not the full secret.
  if (typeof config?.apiKey === "string" && config.apiKey.length >= 16) {
    next.apiKeyPrefix = config.apiKey.slice(0, 16);
  }
  return next;
}

/**
 * Auto-invalidate cached token when the API key has changed (different
 * prefix). Triggered when the user edits ~/.armoriq/credentials.json or
 * the launchctl ARMORIQ_API_KEY env. Without this, the plugin keeps
 * reusing the old token even after the key changes — meaning audit rows
 * land in the old org until the user manually clears runtime.json.
 *
 * Returns true if the cache was invalidated (caller should re-mint).
 */
function invalidateTokenOnKeyChange(session, config) {
  if (!session?.intentTokenRaw) return false;
  if (!session?.apiKeyPrefix) {
    // Legacy session minted before this stamp existed; tolerate it once
    // by stamping now and trusting the token.
    if (typeof config?.apiKey === "string" && config.apiKey.length >= 16) {
      session.apiKeyPrefix = config.apiKey.slice(0, 16);
    }
    return false;
  }
  const currentPrefix =
    typeof config?.apiKey === "string" && config.apiKey.length >= 16
      ? config.apiKey.slice(0, 16)
      : "";
  if (!currentPrefix || currentPrefix === session.apiKeyPrefix) return false;
  // Drift detected — discard the cached token, plan, and expiry so the
  // mint path runs fresh with the new key.
  session.intentTokenRaw = "";
  session.plan = undefined;
  session.allowedActions = [];
  session.expiresAt = 0;
  delete session.apiKeyPrefix;
  return true;
}

function invalidateTokenOnPolicyChange(session, currentPolicyHash) {
  if (!currentPolicyHash) return false;
  const hasCachedIntentState = Boolean(
    session?.intentTokenRaw || session?.plan || session?.expiresAt
  );
  if (!hasCachedIntentState) return false;
  if (session.policyHash && session.policyHash === currentPolicyHash) return false;
  session.intentTokenRaw = "";
  session.allowedActions = [];
  session.expiresAt = 0;
  session.policyHash = currentPolicyHash;
  delete session.intentExecution;
  return true;
}

function invalidateTokenOnCompilerChange(session) {
  const hasCachedIntentState = Boolean(
    session?.intentTokenRaw || session?.plan || session?.expiresAt
  );
  if (!hasCachedIntentState) return false;
  if (session.intentPolicyCompilerVersion === INTENT_POLICY_COMPILER_VERSION) return false;
  session.intentTokenRaw = "";
  session.allowedActions = [];
  session.expiresAt = 0;
  session.intentPolicyCompilerVersion = INTENT_POLICY_COMPILER_VERSION;
  delete session.intentExecution;
  return true;
}

function hasInputIntentToken(input) {
  return [
    input?.intentTokenRaw,
    input?.intent_token_raw,
    input?.intent_token,
    input?.intentToken,
  ].some((value) => typeof value === "string" && value.trim());
}

function formatRemoteVerifyDeny(toolName, verifyResult) {
  const reason = verifyResult?.reason || `intent verification denied for ${toolName}`;
  const validation = isPlainObject(verifyResult?.policyValidation)
    ? verifyResult.policyValidation
    : null;
  const parts = [
    `ArmorClaude remote IAP verify-step denied ${toolName}: ${reason}.`,
    "Local ArmorClaude policy allowed the tool; the backend token/step verification layer denied it.",
  ];
  if (validation) {
    const details = [];
    if (typeof validation.decision_source === "string") {
      details.push(`source=${validation.decision_source}`);
    }
    if (Array.isArray(validation.denied_tools) && validation.denied_tools.length > 0) {
      details.push(`denied_tools=${validation.denied_tools.join(",")}`);
    }
    if (Array.isArray(validation.allowed_tools) && validation.allowed_tools.length > 0) {
      details.push(`allowed_tools=${validation.allowed_tools.join(",")}`);
    }
    if (Array.isArray(validation.matched_policies) && validation.matched_policies.length > 0) {
      const matched = validation.matched_policies
        .map((entry) => entry?.name || entry?.id || entry?.policy_id)
        .filter(Boolean)
        .slice(0, 3);
      if (matched.length > 0) {
        details.push(`matched_policies=${matched.join(",")}`);
      }
    }
    if (details.length > 0) {
      parts.push(`Backend policy validation: ${details.join("; ")}.`);
    }
  }
  parts.push(
    "Refresh the intent after policy changes, and if this persists, update/sync the ArmorIQ backend policy for this agent/workspace."
  );
  return parts.join(" ");
}

function readIntentTokenRaw(input, session) {
  const candidates = [
    input.intentTokenRaw,
    input.intent_token_raw,
    input.intent_token,
    input.intentToken,
    session.intentTokenRaw,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function denyOrAllow(config, reason) {
  if (shouldDeny(config)) {
    return denyPreTool(reason);
  }
  return null;
}

function policyDecisionRequiresApproval(policyDecision) {
  const action = policyDecision?.matchedRule?.action;
  const effect = policyDecision?.matchedRule?.effect;
  return action === "require_approval" || effect === "require_approval";
}

async function evaluateConfiguredPolicy(config, policyState, toolName, toolInput) {
  if (config.enforcementEngine === "opa" && config.opaPdpUrl) {
    const opaInput = compileToOpaInput(policyState.policy, toolName, toolInput);
    return await evaluateOpa(config, opaInput);
  }
  return evaluatePolicy({
    policy: policyState.policy,
    toolName,
    toolParams: toolInput,
  });
}

function preToolPolicyOutput(policyDecision, toolName) {
  if (policyDecisionRequiresApproval(policyDecision)) {
    return askPreTool(
      policyDecision.reason ||
        `ArmorClaude policy requires your approval before running ${toolName}.`
    );
  }
  if (!policyDecision.allowed) {
    return denyPreTool(policyDecision.reason || "ArmorClaude policy denied");
  }
  return null;
}

function debugLog(config, message) {
  if (config.debug) {
    process.stderr.write(`[armorclaude] ${message}\n`);
  }
}

const PLUGIN_PLUMBING_TOOLS = new Set([
  "toolsearch",
  "todowrite",
  "listmcpresourcestool",
  "readmcpresourcetool",
  "exitplanmode",
]);

function isPluginPlumbingTool(toolName) {
  if (typeof toolName !== "string" || !toolName) return false;
  const norm = toolName.toLowerCase();
  if (norm.startsWith("mcp__plugin_armorclaude_")) return true;
  return PLUGIN_PLUMBING_TOOLS.has(norm);
}

/**
 * Emit an audit row. Routing order:
 *   1. daemon (if enabled and reachable) → fire-and-forget, daemon writes to WAL
 *   2. WAL directly (if enabled, when daemon path fails) → durable, recoverable
 *   3. synchronous HTTP POST (legacy fallback when both above are off/down)
 *
 * Returns a short label ("daemon" | "wal" | "http") for debug logging.
 */
async function emitAudit({ dto, config, iapService }) {
  if (config.daemonEnabled) {
    try {
      const { enqueueAuditViaDaemon } = await import("./daemon-client.mjs");
      const ok = await enqueueAuditViaDaemon({ dto, config });
      if (ok) return "enqueued (daemon)";
    } catch (err) {
      debugLog(config, `audit daemon enqueue failed: ${err?.message ?? err}`);
    }
  }
  if (config.auditWal) {
    try {
      const { createAuditWal } = await import("./audit-wal.mjs");
      const wal = createAuditWal({ dataDir: config.dataDir });
      await wal.appendLine(dto);
      return "written (wal)";
    } catch (err) {
      debugLog(config, `audit WAL append failed: ${err?.message ?? err}`);
    }
  }
  await iapService.createAuditLog(dto);
  return "sent (http)";
}

/**
 * Pick the best matching step index in the plan for a given tool call.
 * Prefers a step that matches BOTH tool name and parameters, falls back to
 * tool name only, then to step 0. Used to populate audit log step_index so
 * the backend can advance plan execution state to 'completed'.
 */
function pickStepIndex(plan, toolName, toolInput) {
  if (!plan || typeof plan !== "object") return 0;
  const { matches, paramMatches } = findPlanStepIndices(plan, toolName, toolInput);
  if (paramMatches.length > 0) return paramMatches[0];
  if (matches.length > 0) return matches[0];
  return 0;
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------

export async function handleSessionStart(input, config) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  upsertSession(runtimeState, sessionId, {
    startedAt: nowEpochSeconds(),
    discoveredTools: [],
  });
  await saveRuntimeState(config.runtimeFile, runtimeState);

  // --- Fire-and-forget: sync MCP registry from backend (if apiKey set) ---
  if (config.apiKey) {
    syncMcpRegistry(config)
      .then(async (result) => {
        if (result.ok && result.servers.length) {
          const { setMcpServerStatus: setStatus } = await import("./tool-registry.mjs");
          const fresh = await loadRuntimeState(config.runtimeFile);
          for (const s of result.servers) {
            if (s.mcpName && s.status) {
              setStatus(fresh, s.mcpName, s.status);
            }
          }
          await saveRuntimeState(config.runtimeFile, fresh);
        }
      })
      .catch(() => {});
  }

  // --- Dashboard-authoritative sync: pull the confirmed org policy and make it
  // the locally enforced policy, so the session enforces exactly what the
  // dashboard shows. Awaited so it applies before any tool runs. Fail-safe:
  // never throws and never wipes local policy on error (see the helper).
  let syncNote = "";
  if (config.apiKey) {
    try {
      const pulled = await syncActivePolicyFromBackend(config);
      if (pulled.ok && pulled.changed) {
        syncNote = ` Policy synced from dashboard (v${pulled.version}).`;
        debugLog(config, `policy synced from backend: v${pulled.version}`);
      } else if (!pulled.ok) {
        debugLog(config, `policy sync skipped: ${pulled.reason}`);
      }
    } catch (err) {
      debugLog(config, `policy sync error: ${err?.message || err}`);
    }
  }

  debugLog(config, `session started: ${sessionId}, mode=${config.mode}`);

  const modeLabel = config.mode === "enforce" ? "ENFORCING" : "MONITORING";
  const intentLabel = config.intentRequired ? "required" : "optional";

  // --- First-run onboarding: if no policy.json, show template picker ---
  const onboardingFlag = path.join(config.dataDir, "onboarding-shown");
  let onboardingMsg = "";
  const policyExists = await stat(config.policyFile).then(
    () => true,
    () => false
  );
  if (!policyExists) {
    const flagExists = await stat(onboardingFlag).then(
      () => true,
      () => false
    );
    if (!flagExists) {
      const pick = config.defaultTemplate;
      if (pick && getTemplate(pick)) {
        // Configured default template: stage it as a proposal (never silently
        // applied) via the same command path the user would run by hand. The
        // returned text is the standard proposal, awaiting explicit confirm.
        const proposal = await handleArmorPolicyCommand(`/armor template ${pick}`, config);
        onboardingMsg =
          `\n\nWelcome to ArmorClaude! Your configured default template "${pick}" ` +
          `has been proposed (nothing is active until you confirm):\n\n${proposal}`;
      } else {
        const templates = getTemplateNames();
        const invalidNote =
          pick && !getTemplate(pick)
            ? `\nConfigured default template "${pick}" is not recognized — pick one below.\n`
            : "";
        onboardingMsg =
          "\n\nWelcome to ArmorClaude! No policy is configured yet.\n" +
          invalidNote +
          "Choose a template to get started:\n\n" +
          templates.map((t) => `  /armorclaude:armor policy template ${t}`).join("\n") +
          "\n\nOr add individual rules:\n" +
          "  /armorclaude:armor policy add allow Read and Grep, deny Write, hold Bash\n\n" +
          "Type /armorclaude:armor for all commands.";
      }
      await mkdir(config.dataDir, { recursive: true });
      await writeFile(onboardingFlag, new Date().toISOString(), "utf8");
    }
  }

  return addPromptContext(
    `ArmorClaude active (${modeLabel}, intent=${intentLabel})${syncNote}${onboardingMsg}`,
    "SessionStart"
  );
}

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

export async function handleUserPromptExpansion(input, config) {
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (isArmorPolicyCommand(prompt)) {
    const response = await handleArmorPolicyCommand(prompt, config);
    return armorReply(response);
  }

  const commandName = typeof input?.command_name === "string" ? input.command_name.trim() : "";
  const commandArgs = typeof input?.command_args === "string" ? input.command_args.trim() : "";
  const normalizedCommand = commandName.toLowerCase().replace(/^\/+/, "");
  if (["armor", "armorclaude:armor"].includes(normalizedCommand)) {
    const response = await handleArmorPolicyCommand(`/armor ${commandArgs}`.trim(), config);
    return armorReply(response);
  }
  if (["armor-policy", "armorclaude:armor-policy"].includes(normalizedCommand)) {
    return blockPrompt(legacyArmorPolicyMessage());
  }

  const serialized = JSON.stringify(input || {});
  if (/armorclaude:armor-policy|armor-policy/i.test(serialized)) {
    return blockPrompt(legacyArmorPolicyMessage());
  }
  return null;
}

export async function handleUserPromptSubmit(input, config) {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!prompt || !sessionId) {
    return null;
  }

  // --- /armor commands: human-only, policy-immune ---
  if (isArmorPolicyCommand(prompt)) {
    const response = await handleArmorPolicyCommand(prompt, config);
    return armorReply(response);
  }
  if (/^\s*\/(?:armor-policy|armorclaude:armor-policy)\b/i.test(prompt)) {
    return blockPrompt(legacyArmorPolicyMessage());
  }

  // --- Store prompt in session ---
  const runtimeState = await loadRuntimeState(config.runtimeFile);
  upsertSession(runtimeState, sessionId, {
    lastPrompt: prompt,
    lastPromptAt: nowEpochSeconds(),
  });
  await saveRuntimeState(config.runtimeFile, runtimeState);

  // --- Inject directive: tell Claude to register its intent plan ---
  // Claude will call the `register_intent_plan` MCP tool (or include a JSON
  // block in its plan file) as its first action. This uses the session's own
  // LLM — no separate API key or extra LLM call needed.
  const parts = [];
  if (config.planningEnabled) {
    parts.push(
      "ArmorClaude intent enforcement is active. Before using any tool, " +
        "declare your plan in this exact JSON shape:\n\n" +
        INTENT_PLAN_FORMAT +
        "\n\n" +
        "How to submit:\n" +
        "- If in plan mode: include the JSON block (fenced with ```json) " +
        "at the end of your plan file.\n" +
        "- Otherwise: call `register_intent_plan` with the JSON as the " +
        "argument BEFORE any other tool call.\n" +
        "Tool calls without a registered plan will be blocked."
    );
  }
  if (parts.length > 0) {
    return addPromptContext(parts.join("\n\n"));
  }
  return null;
}

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------

export async function handlePreToolUse(input, config) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = sanitizeParams(input.tool_input, config.sanitize);
  if (!toolName) {
    // Missing tool_name on a PreToolUse event means the payload shape is
    // unexpected. Fail-closed in enforce mode instead of silently allowing.
    return denyOrAllow(config, "ArmorClaude: missing tool_name on PreToolUse");
  }

  // --- Allowlist: ArmorClaude's own MCP tools must never be blocked,
  //     otherwise the agent can't register a plan or read/update policy.
  //     Match the exact MCP prefix from .mcp.json (armorclaude-policy),
  //     not any suffix --- an evil server called evil__policy_update would
  //     previously have been allowlisted. ---
  const norm = normalizeToolName(toolName);
  // ArmorClaude's own MCP tools — meta-tools for managing the plugin itself
  // (declare a plan, inspect/update policy, drive Trust Update primitives).
  // Blocking these creates a deadlock: the agent can't register a plan to
  // unblock itself.
  const armorTools = [
    "register_intent_plan",
    "policy_read",
    "trust_revoke",
    "trust_reanchor",
    "trust_delegate",
  ];
  // Claude Code surfaces MCP tools under different prefixes depending on how
  // the server is loaded:
  //   .mcp.json (top-level)       → mcp__<server>__<tool>
  //   Claude Code plugin manifest → mcp__plugin_<plugin>_<server>__<tool>
  // Match both. The deadlock the user hit ("intent drift: tool not in plan
  // (mcp__plugin_armorclaude_armorclaude-policy__register_intent_plan)")
  // was caused by the plugin-prefix variant being missed.
  const armorMcpPrefixes = [
    "mcp__armorclaude-policy__",
    "mcp__plugin_armorclaude_armorclaude-policy__",
  ];
  if (armorTools.some((t) => norm === t || armorMcpPrefixes.some((pfx) => norm === `${pfx}${t}`))) {
    return null;
  }

  // --- Path guard: block write operations targeting policy/credential files.
  //     Read operations (cat, Read tool) are allowed --- only mutations blocked.
  const PROTECTED_PATHS = [
    config.policyFile,
    path.join(config.dataDir, "policy-pending.json"),
    path.join(config.dataDir, "crypto-policy-state.json"),
    path.join(config.dataDir, "profiles"),
    path.join(homedir(), ".armoriq", "credentials.json"),
  ];
  if (["write", "edit"].includes(norm)) {
    const target = toolInput?.file_path || toolInput?.path || "";
    if (
      typeof target === "string" &&
      PROTECTED_PATHS.some(
        (p) =>
          path.resolve(target) === path.resolve(p) ||
          target.includes("armorclaude/policy") ||
          target.includes("armorclaude/profiles")
      )
    ) {
      return denyPreTool(
        "ArmorClaude: direct modification of policy files is blocked. Use /armorclaude:armor policy commands."
      );
    }
  }
  if (norm === "bash") {
    const cmd = typeof toolInput?.command === "string" ? toolInput.command : "";
    // Block direct invocation of the policy handler via Node/Bash.
    // Claude could bypass the UserPromptSubmit hook by importing and calling
    // handleArmorPolicyCommand directly --- this guard closes that vector.
    if (
      /armor-policy-commands|handleArmorPolicyCommand|armor-policy-cli|savePolicyState|writeJson|policy-pending|crypto-policy-state/i.test(
        cmd
      )
    ) {
      return denyPreTool(
        "ArmorClaude: policy management is human-only. Type /armorclaude:armor policy in the terminal."
      );
    }
    const WRITE_OPS =
      /\b(>|>>|tee|mv|cp|rm|sed\s+-i|awk\s.*>|chmod|cat\s*<<|echo.*>|truncate|dd\b)/;
    if (PROTECTED_PATHS.some((p) => cmd.includes(path.basename(p))) && WRITE_OPS.test(cmd)) {
      return denyPreTool(
        "ArmorClaude: shell write commands targeting policy files are blocked. Use /armorclaude:armor policy commands."
      );
    }
  }

  // --- ExitPlanMode interception: capture the plan, then allow ---
  if (norm === "exitplanmode") {
    return await handleExitPlanModeCapture(input, sessionId, config);
  }

  // --- Allowlist: Claude Code introspection / coordination tools that have
  //     no side effects on user files or systems. Blocking these makes the
  //     agent fight itself (e.g. ToolSearch is needed to fetch deferred MCP
  //     tool schemas before they can be called). ---
  //
  // Phase 4 A1 (2026-05-08): expanded with built-in read-only Claude Code
  // tools that observe filesystem/network without mutating either. These get
  // a hot-path return before any disk read, plan check, or backend HTTP —
  // saves 30-350 ms per call. Bash is intentionally NOT here: it can do
  // anything (rm -rf, curl, kill) and must continue through the full
  // pipeline. Same for Edit/Write/NotebookEdit (mutating) and any MCP tool
  // that isn't an ArmorClaude meta-tool (already handled above).
  const coordinationTools = new Set([
    // Claude Code coordination (no side effects)
    "toolsearch",
    "todowrite",
    "listmcpresourcestool",
    "readmcpresourcetool",
    "exitplanmode",
  ]);
  if (coordinationTools.has(norm)) {
    return null;
  }

  const readOnlyPolicyTools = new Set(["read", "grep", "glob", "websearch", "webfetch"]);
  if (readOnlyPolicyTools.has(norm)) {
    const safePolicyState = await loadPolicyState(config.policyFile);
    const safePolicyDecision = await evaluateConfiguredPolicy(
      config,
      safePolicyState,
      toolName,
      toolInput
    );
    const safePolicyOutput = preToolPolicyOutput(safePolicyDecision, toolName);
    if (safePolicyOutput) return safePolicyOutput;
    return null;
  }

  // --- Load runtime state (reused for MCP gate, plan consumption, and rest of handler) ---
  const runtimeState = await loadRuntimeState(config.runtimeFile);

  // --- MCP deny-by-default gate ---
  // External MCP tools are denied until the user explicitly approves the server.
  // Skills (Anthropic-vetted) are allowed by default but tracked.
  let mcpApprovalReason = "";
  if (config.mcpDenyByDefault !== false) {
    const identity = parseToolIdentity(toolName);
    if (identity.category === "external-mcp" || identity.category === "plugin-mcp") {
      const server = identity.serverName;
      const entry = getMcpServerStatus(runtimeState, server);
      if (!entry || entry.status !== "approved") {
        if (!entry) {
          setMcpServerStatus(runtimeState, server, "pending");
          await saveRuntimeState(config.runtimeFile, runtimeState);
          autoRegisterMcp(config, server).catch(() => {});
        }
        mcpApprovalReason =
          `ArmorClaude: MCP server "${server}" is not approved. ` +
          "Approve this one tool call in Claude Code, or type " +
          `/armorclaude:armor mcp approve ${server} to trust this server persistently.`;
      }
      if (entry?.status === "denied") {
        return denyPreTool(
          `ArmorClaude: MCP server "${server}" is denied by policy. ` +
            `Type /armorclaude:armor policy mcp approve ${server} to change this.`
        );
      }
    }
  }

  // --- Consume pending plan from register_intent_plan MCP tool ---
  // Always consume if a pending file exists — the MCP handler only writes
  // it when Claude has registered a NEW plan, and stale plans must be
  // overwritten so each prompt gets its own plan boundary.
  const sessionPendingPath = sessionId
    ? path.join(config.dataDir, `pending-plan.${sessionId}.json`)
    : null;
  const legacyPendingPath = path.join(config.dataDir, "pending-plan.json");
  let pendingPath = sessionPendingPath;
  let pending = sessionPendingPath ? await readJson(sessionPendingPath, null) : null;
  if (!pending) {
    pending = await readJson(legacyPendingPath, null);
    pendingPath = legacyPendingPath;
  }
  if (pending && (pending.tokenRaw || pending.plan)) {
    const pendingPolicyState = await loadPolicyState(config.policyFile);
    const pendingPolicyHash = computePolicyHash(pendingPolicyState.policy);
    // --- Auto-reanchor (Phase 3): if the previous plan + token exist for
    // this session and the new plan hash differs, sign a ReAnchor delta
    // *before* overwriting the cached plan. The audit log now reads
    // Commit → ReAnchor → ... instead of orphan Commits.
    if (config.autoReanchor && pending.plan) {
      const priorSession = getSession(runtimeState, sessionId);
      const priorTokenRaw = priorSession?.intentTokenRaw;
      const priorPlan = priorSession?.plan;
      if (priorTokenRaw && priorPlan) {
        const localPriorHash = sha256Hex(JSON.stringify(priorPlan));
        const localNextHash = sha256Hex(JSON.stringify(pending.plan));
        if (localPriorHash !== localNextHash) {
          let priorTokenObj;
          try {
            priorTokenObj = JSON.parse(priorTokenRaw);
          } catch {
            priorTokenObj = null;
          }
          if (priorTokenObj) {
            const canonicalPriorHash =
              priorTokenObj?.planHash || priorTokenObj?.rawToken?.token?.plan_hash || "";
            // Prefer the canonical planHash from pending.tokenRaw (if a new
            // token was minted alongside the new plan) so trustOpsLog hashes
            // stay cross-referencable with backend trust_deltas rows even
            // when the SDK reanchor call fails. sha256(JSON.stringify(plan))
            // is a last-resort identifier — different from the CSRG canonical
            // hash and therefore not auditable against TrustDelta.payload.
            let canonicalNextHash = "";
            if (pending.tokenRaw && typeof pending.tokenRaw === "string") {
              try {
                const pendingTokenObj = JSON.parse(pending.tokenRaw);
                canonicalNextHash =
                  pendingTokenObj?.planHash || pendingTokenObj?.rawToken?.token?.plan_hash || "";
              } catch {
                // ignore — fall through to localNextHash below
              }
            }
            const result = await reanchorViaSdk({
              getClient: getSdkClient,
              config,
              intentToken: priorTokenObj,
              updatedPlan: pending.plan,
              reason: "armorclaude:plan-delta",
            });
            appendTrustOp(runtimeState, sessionId, {
              operation: "ReAnchor",
              trustId: result.trustId,
              fromHash: result.fromHash || canonicalPriorHash || localPriorHash,
              toHash: result.toHash || canonicalNextHash || localNextHash,
              reason: "plan delta detected at PreToolUse",
              ok: result.ok,
            });
            debugLog(
              config,
              `[trust] auto-reanchor ${result.ok ? "ok" : "failed"} prior=${localPriorHash.slice(0, 12)} new=${localNextHash.slice(0, 12)} trustId=${result.trustId || "n/a"}`
            );
            if (!result.ok) {
              debugLog(
                config,
                `[trust] reanchor error: ${result.error || "unknown"}${result.status ? ` status=${result.status}` : ""}${result.body ? ` body=${JSON.stringify(result.body).slice(0, 300)}` : ""}`
              );
            }
          }
        }
      }
    }

    upsertSession(runtimeState, sessionId, {
      intentTokenRaw:
        pending.intentPolicyCompilerVersion === INTENT_POLICY_COMPILER_VERSION
          ? pending.tokenRaw || ""
          : "",
      plan: pending.plan,
      allowedActions: Array.isArray(pending.allowedActions) ? pending.allowedActions : [],
      expiresAt: pending.expiresAt,
      policyHash: pending.policyHash || pendingPolicyHash,
      intentPolicyCompilerVersion: INTENT_POLICY_COMPILER_VERSION,
      // Reset per-token execution tracking when a new plan replaces the old.
      intentExecution: undefined,
    });
    await saveRuntimeState(config.runtimeFile, runtimeState);
    await unlink(pendingPath).catch(() => {});
    debugLog(config, "consumed pending plan from register_intent_plan");
  }

  // --- Static policy evaluation ---
  const policyState = await loadPolicyState(config.policyFile);
  const currentPolicyHash = computePolicyHash(policyState.policy);

  // Crypto policy digest check (Phase 4 integration point)
  if (config.cryptoPolicyEnabled) {
    try {
      const { createCryptoPolicyService } = await import("./crypto-policy.mjs");
      const cryptoService = createCryptoPolicyService(config);
      const cachedState = await cryptoService.loadCachedState();
      if (cachedState?.policyDigest) {
        const check = cryptoService.verifyPolicyDigest(currentPolicyHash, cachedState.policyDigest);
        if (!check.valid) {
          return denyOrAllow(config, `ArmorClaude crypto policy mismatch: ${check.reason}`);
        }
      }
    } catch (error) {
      debugLog(config, `crypto policy check error: ${error}`);
    }
  }

  // --- Policy evaluation: dispatch based on enforcement engine ---
  let policyDecision = await evaluateConfiguredPolicy(config, policyState, toolName, toolInput);
  const requiresUserApproval = policyDecisionRequiresApproval(policyDecision);
  if (!policyDecision.allowed && !requiresUserApproval) {
    return denyPreTool(policyDecision.reason || "ArmorClaude policy denied");
  }

  // --- Intent token verification ---
  // Reuse the runtimeState loaded above instead of re-reading from disk.
  const session = getSession(runtimeState, sessionId) || {};
  // Auto-reload on credential change: if the cached token was minted with
  // a different API key than the one currently configured, discard it so
  // the mint path runs fresh below. Otherwise editing
  // ~/.armoriq/credentials.json silently has no effect until the token
  // expires.
  if (invalidateTokenOnKeyChange(session, config)) {
    debugLog(config, "API key changed (prefix differs); discarded cached token for fresh mint");
    upsertSession(runtimeState, sessionId, session);
  }
  if (invalidateTokenOnCompilerChange(session)) {
    debugLog(config, "Intent policy compiler changed; discarded cached intent token");
    upsertSession(runtimeState, sessionId, session);
  }
  const policyTokenInvalidated = invalidateTokenOnPolicyChange(session, currentPolicyHash);
  if (policyTokenInvalidated) {
    debugLog(config, "Policy hash changed; discarded cached intent token for fresh verification");
    upsertSession(runtimeState, sessionId, session);
  }
  let intentTokenRaw =
    policyTokenInvalidated || (!session.policyHash && hasInputIntentToken(input))
      ? ""
      : readIntentTokenRaw(input, session);
  let localPlan = session.plan;
  let localExpiresAt = session.expiresAt;
  let remoteAllowed = false;
  let tokenCheckMatched = false;
  let usedStepIndices =
    intentTokenRaw && localPlan
      ? getSessionTokenUsedStepIndices(session, intentTokenRaw)
      : undefined;

  // Proactive refresh: if the token is about to expire and we still have the
  // plan, re-issue silently so the user never sees a "token expired" deny in
  // the middle of a multi-step turn. If the refresh fails, flow falls through
  // to the existing expiry check below.
  const refreshThreshold = Number.isFinite(config.refreshThresholdSeconds)
    ? config.refreshThresholdSeconds
    : 30;
  if (
    intentTokenRaw &&
    isPlainObject(localPlan) &&
    Number.isFinite(localExpiresAt) &&
    localExpiresAt - nowEpochSeconds() < refreshThreshold &&
    config.apiKey
  ) {
    try {
      const refreshed = await requestIntent(config, {
        prompt: session.lastPrompt || `Refresh intent for ${toolName}`,
        plan: localPlan,
        session_id: sessionId,
        toolName,
        toolInput,
        policy_hash: currentPolicyHash,
        policy: policyState.policy,
        validitySeconds: config.validitySeconds,
        metadata: { source: "claude-code", trigger: "auto_refresh" },
      });
      if (!refreshed.skipped) {
        const merged = mergeIntentIntoSession(session, refreshed, config);
        merged.policyHash = currentPolicyHash;
        merged.intentPolicyCompilerVersion = INTENT_POLICY_COMPILER_VERSION;
        upsertSession(runtimeState, sessionId, merged);
        intentTokenRaw =
          typeof merged.intentTokenRaw === "string" ? merged.intentTokenRaw : intentTokenRaw;
        localPlan = merged.plan || localPlan;
        localExpiresAt = merged.expiresAt || localExpiresAt;
        debugLog(config, "intent token auto-refreshed near expiry");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(config, `auto-refresh failed: ${message}`);
    }
  }

  // If no token, try to acquire one
  if (!intentTokenRaw && config.apiKey) {
    try {
      const intentResponse = await requestIntent(config, {
        prompt: session.lastPrompt || `Use tool ${toolName}`,
        session_id: sessionId,
        toolName,
        toolInput,
        policy_hash: currentPolicyHash,
        policy: policyState.policy,
        validitySeconds: config.validitySeconds,
        metadata: {
          source: "claude-code",
          trigger: "pre_tool_use",
        },
      });
      const merged = mergeIntentIntoSession(session, intentResponse, config);
      merged.policyHash = currentPolicyHash;
      merged.intentPolicyCompilerVersion = INTENT_POLICY_COMPILER_VERSION;
      upsertSession(runtimeState, sessionId, merged);
      intentTokenRaw = typeof merged.intentTokenRaw === "string" ? merged.intentTokenRaw : "";
      localPlan = merged.plan || localPlan;
      localExpiresAt = merged.expiresAt || localExpiresAt;
      usedStepIndices =
        intentTokenRaw && localPlan
          ? getSessionTokenUsedStepIndices(merged, intentTokenRaw)
          : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.intentRequired && shouldDeny(config)) {
        return denyPreTool(`ArmorClaude intent planning failed: ${message}`);
      }
    }
  }

  // Validate tool against intent token plan
  if (intentTokenRaw) {
    const tokenCheck = checkIntentTokenPlan({
      intentTokenRaw,
      toolName,
      toolParams: toolInput,
    });
    if (tokenCheck.matched) {
      tokenCheckMatched = true;
      if (tokenCheck.blockReason) {
        return denyOrAllow(config, tokenCheck.blockReason);
      }
      localPlan = tokenCheck.plan || localPlan;
      remoteAllowed = true;
    }
  }

  // --- CSRG proof handling ---
  const parsedProofs = parseCsrgProofHeaders(input);
  if (parsedProofs.error) {
    return denyOrAllow(config, parsedProofs.error);
  }
  let csrgProofs = parsedProofs.proofs;
  if (!csrgProofs && intentTokenRaw && localPlan && typeof localPlan === "object") {
    const resolved = resolveCsrgProofsFromToken({
      intentTokenRaw,
      plan: localPlan,
      toolName,
      toolParams: toolInput,
      usedStepIndices,
    });
    if (resolved) {
      csrgProofs = resolved;
    }
  }
  const proofError = validateCsrgProofHeaders(
    csrgProofs,
    config.requireCsrgProofs &&
      config.csrgVerifyEnabled &&
      Boolean(config.verifyStepEndpoint) &&
      Boolean(intentTokenRaw)
  );
  if (proofError) {
    return denyOrAllow(config, proofError);
  }

  // --- Remote step verification ---
  if (intentTokenRaw && config.verifyStepEndpoint && config.csrgVerifyEnabled) {
    try {
      const iapService = createIapService(config);
      const verifyResult = await iapService.verifyStep(intentTokenRaw, csrgProofs, toolName);
      if (!verifyResult.skipped) {
        remoteAllowed = verifyResult.allowed === true;
      }
      if (verifyResult.allowed === false) {
        return denyOrAllow(config, formatRemoteVerifyDeny(toolName, verifyResult));
      }
      const merged = mergeIntentIntoSession(session, verifyResult, config);
      merged.policyHash = currentPolicyHash;
      merged.intentPolicyCompilerVersion = INTENT_POLICY_COMPILER_VERSION;
      upsertSession(runtimeState, sessionId, merged);
      localPlan = merged.plan || localPlan;
      localExpiresAt = merged.expiresAt || localExpiresAt;
      if (typeof verifyResult.stepIndex === "number") {
        const indices = usedStepIndices || new Set();
        indices.add(verifyResult.stepIndex);
        recordSessionTokenUsedStepIndices(merged, intentTokenRaw, indices);
      } else if (usedStepIndices && intentTokenRaw) {
        recordSessionTokenUsedStepIndices(merged, intentTokenRaw, usedStepIndices);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const deny = denyOrAllow(config, `ArmorClaude verify-step failed: ${message}`);
      if (deny) {
        return deny;
      }
    }
  }

  // --- Expiry check ---
  if (Number.isFinite(localExpiresAt) && localExpiresAt > 0 && nowEpochSeconds() > localExpiresAt) {
    const deny = denyOrAllow(
      config,
      "ArmorClaude intent token expired — call register_intent_plan with your current plan to refresh, then retry the tool"
    );
    if (deny) {
      return deny;
    }
  }

  // --- Local plan enforcement (no backend / no token) ---
  // When a plan was registered via register_intent_plan but ArmorIQ is not
  // configured, enforce the plan locally: tool must be in plan, and params
  // (if declared in step.metadata.inputs) must match.
  let localPlanMatched = false;
  if (!intentTokenRaw && localPlan && typeof localPlan === "object") {
    const localCheck = checkToolAgainstPlan({
      plan: localPlan,
      toolName,
      toolInput,
      strict: !!config.strictParamCheck,
    });
    if (localCheck.allowed) {
      localPlanMatched = true;
    } else {
      // Phase 4 A3: include the exact register_intent_plan JSON in the deny
      // reason so the LLM auto-corrects in 1 follow-up turn.
      if (shouldDeny(config)) {
        return denyPreToolWithHint(localCheck.reason || "ArmorClaude intent drift", {
          toolName,
          toolInput,
          goal: session.lastPrompt,
          knownPlan: localPlan,
        });
      }
    }
  }

  // --- Enforce intent requirement ---
  if (config.intentRequired && !remoteAllowed && !tokenCheckMatched && !localPlanMatched) {
    if (shouldDeny(config)) {
      return denyPreToolWithHint("ArmorClaude intent plan missing for this session", {
        toolName,
        toolInput,
        goal: session.lastPrompt,
      });
    }
    const deny = denyOrAllow(config, "ArmorClaude intent plan missing for this session");
    if (deny) {
      return deny;
    }
  }

  // --- Record tool for discovery ---
  upsertDiscoveredTool(runtimeState, toolName);
  await saveRuntimeState(config.runtimeFile, runtimeState);
  if (mcpApprovalReason) {
    return askPreTool(mcpApprovalReason);
  }
  if (requiresUserApproval) {
    return askPreTool(
      policyDecision.reason ||
        `ArmorClaude policy requires your approval before running ${toolName}.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// ExitPlanMode capture — intercept Claude's built-in plan approval
// ---------------------------------------------------------------------------

async function handleExitPlanModeCapture(input, sessionId, config) {
  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const session = getSession(runtimeState, sessionId) || {};

  try {
    const planFilePath = resolvePlanFilePath(input);
    if (planFilePath) {
      // Prefer structured JSON block (from the directive) over heuristic parsing
      const { readFile } = await import("node:fs/promises");
      let plan = null;
      try {
        const content = await readFile(planFilePath, "utf8");
        const jsonBlock = extractPlanJsonBlock(content);
        if (jsonBlock) {
          const parsed = INTENT_PLAN_ZOD.safeParse(jsonBlock);
          if (parsed.success) {
            plan = normalizeIntentPlan(parsed.data);
            plan.metadata.source = "plan-file-json";
          }
        }
      } catch {
        /* fall through to heuristic */
      }

      // Fallback: heuristic markdown parsing
      if (!plan) {
        plan = await parsePlanFile(planFilePath);
      }

      if (plan && plan.steps.length > 0) {
        debugLog(
          config,
          `captured plan from ExitPlanMode: ${plan.steps.length} steps (${plan.metadata?.source || "heuristic"})`
        );

        // Send plan to ArmorIQ for intent token
        if (config.apiKey) {
          const policyState = await loadPolicyState(config.policyFile);
          const policyHash = computePolicyHash(policyState.policy);
          const intentResponse = await requestIntent(config, {
            prompt: session.lastPrompt || plan.metadata?.goal || "Plan execution",
            plan,
            session_id: sessionId,
            policy_hash: policyHash,
            policy: policyState.policy,
            validitySeconds: config.validitySeconds,
            metadata: { source: "claude-code", planning: "plan-mode" },
          });
          const merged = mergeIntentIntoSession(session, intentResponse, config);
          merged.policyHash = policyHash;
          merged.intentPolicyCompilerVersion = INTENT_POLICY_COMPILER_VERSION;
          upsertSession(runtimeState, sessionId, merged);
        } else {
          // Store plan locally without ArmorIQ token
          session.plan = plan;
          session.allowedActions = Array.from(extractAllowedActions(plan));
          upsertSession(runtimeState, sessionId, session);
        }

        await saveRuntimeState(config.runtimeFile, runtimeState);
      }
    }
  } catch (error) {
    debugLog(config, `ExitPlanMode capture error: ${error}`);
  }

  // Always allow ExitPlanMode to proceed
  return null;
}

// ---------------------------------------------------------------------------
// PostToolUse — audit logging
// ---------------------------------------------------------------------------

export async function handlePostToolUse(input, config) {
  if (!config.auditEnabled || !config.apiKey) {
    return null;
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!toolName) return null;

  if (isPluginPlumbingTool(toolName)) return null;

  try {
    const runtimeState = await loadRuntimeState(config.runtimeFile);
    const session = getSession(runtimeState, sessionId) || {};
    const iapService = createIapService(config);

    const intentTokenRaw = session.intentTokenRaw || "";
    if (!intentTokenRaw) return null;
    let token = intentTokenRaw;
    // Extract JWT if embedded in JSON envelope
    if (intentTokenRaw.startsWith("{")) {
      try {
        const parsed = JSON.parse(intentTokenRaw);
        token = parsed.jwtToken || parsed.jwt_token || intentTokenRaw;
      } catch {
        /* use raw */
      }
    }

    // Compute the real step index from the registered plan so the backend's
    // updateExecutionProgress can advance plan status to 'completed'.
    const inputs = sanitizeParams(input.tool_input, config.sanitize);
    const stepIdx = pickStepIndex(session.plan, toolName, inputs);

    const dto = {
      token,
      step_index: stepIdx,
      action: toolName,
      tool: toolName,
      input: redactSecrets(inputs),
      output: redactSecrets(sanitizeParams(input.tool_response, config.sanitize)),
      status: "success",
      executed_at: new Date().toISOString(),
      duration_ms: 0,
    };

    // Phase 4 A4 (via Tier B): if daemon is enabled, enqueue the audit DTO
    // for fire-and-forget batched flush. This actually delivers the
    // latency win — without daemon, we still need to await the POST because
    // the hook process can't exit while a socket is open.
    const target = await emitAudit({ dto, config, iapService });
    debugLog(config, `audit log ${target} for ${toolName} step=${stepIdx}`);
  } catch (error) {
    // Audit is best-effort — don't block
    debugLog(config, `audit log failed: ${error}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// PostToolUseFailure — audit logging for failed tool calls
// ---------------------------------------------------------------------------

export async function handlePostToolUseFailure(input, config) {
  if (!config.auditEnabled || !config.apiKey) {
    return null;
  }

  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (!toolName) return null;

  if (isPluginPlumbingTool(toolName)) return null;

  try {
    const runtimeState = await loadRuntimeState(config.runtimeFile);
    const session = getSession(runtimeState, sessionId) || {};
    const iapService = createIapService(config);

    const intentTokenRaw = session.intentTokenRaw || "";
    if (!intentTokenRaw) return null;
    let token = intentTokenRaw;
    if (intentTokenRaw.startsWith("{")) {
      try {
        const parsed = JSON.parse(intentTokenRaw);
        token = parsed.jwtToken || parsed.jwt_token || intentTokenRaw;
      } catch {
        /* use raw */
      }
    }

    const inputs = sanitizeParams(input.tool_input, config.sanitize);
    const stepIdx = pickStepIndex(session.plan, toolName, inputs);
    const dto = {
      token,
      step_index: stepIdx,
      action: toolName,
      tool: toolName,
      input: redactSecrets(inputs),
      output: null,
      status: "failed",
      error_message: typeof input.error === "string" ? redactSecrets(input.error) : "Unknown error",
      executed_at: new Date().toISOString(),
      duration_ms: 0,
    };

    const target = await emitAudit({ dto, config, iapService });
    debugLog(config, `audit log (failure) ${target} for ${toolName}`);
  } catch (error) {
    debugLog(config, `audit log (failure) failed: ${error}`);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Stop — end of turn
// ---------------------------------------------------------------------------

export async function handleStop(input, config) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const session = getSession(runtimeState, sessionId);
  if (!session) return null;

  // Check if token expired mid-turn
  if (Number.isFinite(session.expiresAt) && nowEpochSeconds() > session.expiresAt) {
    debugLog(config, "intent token expired during turn");
  }

  // --- Phase 4 A2: proactive token refresh at turn boundary ---
  // The original refresh fires INSIDE handlePreToolUse when a token is near
  // expiry (engine.mjs:444-486). That's the worst place — Claude is mid-turn
  // and every subsequent tool waits the 150-300 ms HTTP RTT.
  //
  // Move that refresh here, to Stop hook (between turns). The user is reading
  // Claude's output; nothing is gated. Next turn starts with a fresh token,
  // zero latency on the PreToolUse critical path. The PreToolUse refresh
  // stays as a fallback for edge cases (very short turns, long pauses).
  const refreshThresholdSec = Number.isFinite(config.refreshThresholdSeconds)
    ? config.refreshThresholdSeconds
    : 30;
  // Refresh more aggressively at turn boundary than mid-turn — predict the
  // user's next turn could fire a tool within ~2-3 minutes, so refresh if
  // less than `refreshThresholdSec * 4` left.
  const stopRefreshThresholdSec = refreshThresholdSec * 4;
  const tokenLeft = Number.isFinite(session.expiresAt) ? session.expiresAt - nowEpochSeconds() : 0;
  if (
    session.intentTokenRaw &&
    isPlainObject(session.plan) &&
    tokenLeft > 0 &&
    tokenLeft < stopRefreshThresholdSec &&
    config.apiKey
  ) {
    try {
      const policyState = await loadPolicyState(config.policyFile);
      const policyHash = computePolicyHash(policyState.policy);
      const refreshed = await requestIntent(config, {
        prompt: session.lastPrompt || "Stop-hook proactive refresh",
        plan: session.plan,
        session_id: sessionId,
        policy_hash: policyHash,
        policy: policyState.policy,
        validitySeconds: config.validitySeconds,
        metadata: { source: "claude-code", trigger: "stop_proactive_refresh" },
      });
      if (!refreshed.skipped) {
        const merged = mergeIntentIntoSession(session, refreshed, config);
        merged.policyHash = policyHash;
        merged.intentPolicyCompilerVersion = INTENT_POLICY_COMPILER_VERSION;
        upsertSession(runtimeState, sessionId, merged);
        debugLog(
          config,
          `[A2] token pre-refreshed at Stop, was ${tokenLeft}s left, threshold=${stopRefreshThresholdSec}s`
        );
      }
    } catch (error) {
      // Best-effort. If refresh fails, the in-line refresh in PreToolUse
      // will fire on the next tool call as a safety net.
      const msg = error instanceof Error ? error.message : String(error);
      debugLog(config, `[A2] stop-refresh failed (will fall back to in-line): ${msg}`);
    }
  }

  upsertSession(runtimeState, sessionId, {
    lastStopAt: nowEpochSeconds(),
  });
  await saveRuntimeState(config.runtimeFile, runtimeState);
  return null;
}

// ---------------------------------------------------------------------------
// SessionEnd — cleanup
// ---------------------------------------------------------------------------

export async function handleSessionEnd(input, config) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const session = runtimeState.sessions ? runtimeState.sessions[sessionId] : undefined;

  // --- Auto-revoke (Phase 3): kill the active intent token at session end
  // so the 15-minute lifetime can't outlive the Claude Code session. The
  // SDK's revoke is best-effort; failure logs but doesn't block cleanup.
  if (config.autoRevokeOnEnd && session?.intentTokenRaw) {
    if (!Number.isFinite(session.expiresAt) || session.expiresAt > nowEpochSeconds()) {
      let intentToken = null;
      try {
        intentToken = JSON.parse(session.intentTokenRaw);
      } catch {
        intentToken = null;
      }
      const result = await revokeViaSdk({
        getClient: getSdkClient,
        config,
        intentToken,
        reason: "armorclaude:session-ended",
        cascade: false,
      });
      appendTrustOp(runtimeState, sessionId, {
        operation: "Revoke",
        trustId: result.trustId,
        reason: "session ended",
        ok: result.ok,
      });
      debugLog(
        config,
        `[trust] session-end revoke ${result.ok ? "ok" : "failed"} trustId=${result.trustId || "n/a"}`
      );
    }
  }

  // Remove the session entirely (after the trust op was logged + persisted)
  if (runtimeState.sessions && runtimeState.sessions[sessionId]) {
    delete runtimeState.sessions[sessionId];
  }
  await saveRuntimeState(config.runtimeFile, runtimeState);

  debugLog(config, `session ended: ${sessionId}`);
  return null;
}
