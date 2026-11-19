import {
  isPlainObject,
  normalizeToolName,
  nowEpochSeconds,
  redactSecrets,
  sanitizeParams,
} from "./common.mjs";
import {
  DECISION_CODE,
  addPromptContext,
  armorReply,
  allowWithNotice,
  askPreTool,
  blockPrompt,
  denyPreTool,
  denyPreToolWithHint,
  isBillingError,
} from "./hook-output.mjs";
import {
  isArmorPolicyCommand,
  handleArmorPolicyCommand,
  syncActivePolicyFromBackend,
} from "./armor-policy-commands.mjs";
import { getTemplateNames, getTemplate } from "./policy-templates.mjs";
import {
  checkIntentTokenPlan,
  billingUpgradeUrl,
  checkToolAgainstPlan,
  extractAllowedActions,
  findPlanStepIndices,
  getSdkClient,
  getSessionTokenUsedStepIndices,
  parseCsrgProofHeaders,
  planCheckDenial,
  recordSessionTokenUsedStepIndices,
  refreshIntent,
  resolveCsrgProofsFromToken,
  validateCsrgProofHeaders,
} from "./intent.mjs";
import { createIapService, reanchorViaSdk, revokeViaSdk } from "./iap-service.mjs";
import { PolicyFileError, computePolicyHash, evaluatePolicy, loadPolicyState } from "./policy.mjs";
import { normalizePolicyIr } from "./policy-ir.mjs";
import { INTENT_PLAN_FORMAT } from "./intent-schema.mjs";
import { recordsPreToolActivity } from "./hook-activity.mjs";
import { localOnly, notSignedIn, withBackendPosture } from "./config.mjs";
import { readJson, writePrivateFile } from "./fs-store.mjs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import {
  appendTrustOp,
  getSession,
  loadRuntimeState,
  planCheckFile,
  recordHookActivity,
  saveRuntimeState,
  sameGenerations,
  startPrompt,
  tokenPlanCheck,
  updateRuntimeState,
  updateRunState,
  upsertDiscoveredTool,
  upsertSession,
} from "./runtime-state.mjs";
import { sha256Hex } from "./common.mjs";
import { invokesPolicyAdmin, isProtectedPath, writesProtectedPath } from "./shell-guard.mjs";
import { parseToolIdentity, getMcpServerStatus, setMcpServerStatus } from "./tool-registry.mjs";
import { autoRegisterMcp, syncMcpRegistry } from "./backend-client.mjs";
import { activeV2PolicyNames, decideV2, resolveV2Hold } from "./v2-decision.mjs";
import { dropWouldBe, monitorAfterFetch, rememberWouldBe, takeWouldBe } from "./org-mode.mjs";
import { evaluateOpa } from "./opa-client.mjs";
import { compileToOpaInput } from "./policy-compiler.mjs";
import { selfUpdateOnHook, withNotice } from "./self-update.mjs";
import { createAuditEnvelope, snapshotAuditContext, emitAudit } from "./audit-capture.mjs";
import { decisionCode } from "./decision-codes.mjs";
import { recordCaptureFailure } from "./audit-wal.mjs";
import { closeRun, recordRunTool, recoverRuns } from "./runs.mjs";

// In-memory store for tool-call start timestamps. Keyed by tool_use_id
// (or sessionId:toolName fallback). Entries are deleted after PostToolUse /
// PostToolUseFailure so the map doesn't grow unboundedly.
const _toolStartTimes = new Map();
const _toolPolicySources = new Map();

/** Derive a stable key for the tool-start-time map. */
function _toolTimingKey(input) {
  if (typeof input.tool_use_id === "string" && input.tool_use_id) {
    return input.tool_use_id;
  }
  const sid = typeof input.session_id === "string" ? input.session_id : "";
  const tn = typeof input.tool_name === "string" ? input.tool_name : "";
  return `${sid}:${tn}`;
}

/** Record the start timestamp for a tool call. */
export function _recordToolStart(input) {
  _toolStartTimes.set(_toolTimingKey(input), Date.now());
}

/**
 * Compute elapsed duration_ms for a tool call.
 * Returns null if no start timestamp was recorded (never fabricates a duration).
 * Deletes the entry after retrieval.
 */
export function _computeToolDuration(input) {
  const key = _toolTimingKey(input);
  const start = _toolStartTimes.get(key);
  _toolStartTimes.delete(key);
  if (start == null) return null;
  return Date.now() - start;
}

function takePolicySource(input) {
  const key = _toolTimingKey(input);
  const source = _toolPolicySources.get(key);
  _toolPolicySources.delete(key);
  return source;
}

// Exposed for testing only — clear all entries.
export function _clearToolStartTimes() {
  _toolStartTimes.clear();
}

const INTENT_POLICY_COMPILER_VERSION = "sdk-csrg-policy-v1";

function shouldDeny(config) {
  return config.mode === "enforce";
}

function isFrictionlessAllowPolicy(policy) {
  try {
    const ir = normalizePolicyIr(policy);
    return ir.defaults.decision === "allow" && ir.statements.every((s) => s.effect === "permit");
  } catch {
    return false;
  }
}

function intentMode(config, policy) {
  if (!config.intentRequired) return "optional";
  return isFrictionlessAllowPolicy(policy) ? "capture" : "required";
}

async function captureNotice(config) {
  const recorded = "Tool calls are recorded against the registered plan.";
  const names = await activeV2PolicyNames(config);
  if (names?.length === 0) return `${recorded} The current policy blocks none of them.`;
  const which = names?.length
    ? `ArmorIQ ${names.length > 1 ? "policies" : "policy"} ${names.map((n) => `"${n}"`).join(", ")}`
    : "Your organization's ArmorIQ policies";
  return (
    `${recorded} ${which} still ${names?.length === 1 ? "decides" : "decide"} each call: a call may be blocked, or held until ` +
    "another member approves it. Retry a held call with the same arguments after it is approved."
  );
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
 * Drop the cached intent token when a new `armoriq login` changed the key prefix,
 * or audit rows keep landing in the old org. True means the caller must re-mint.
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
  if (session.planCaptured) {
    delete session.plan;
    delete session.planCaptured;
  }
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
  if (session.promptId) return session.intentTokenRaw || "";
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

function denyOrAllow(config, code, reason) {
  if (shouldDeny(config)) {
    return denyPreTool(code, reason);
  }
  return null;
}

async function tokenBlocked(config, tokenCheck) {
  if (!tokenCheck.planCheckDenied) {
    return denyOrAllow(config, "intent_token_blocked", tokenCheck.blockReason);
  }
  if (!shouldDeny(config)) {
    const { appendDaemonLog } = await import("./daemon-log.mjs");
    appendDaemonLog(config.dataDir, `[armorclaude] monitor: ${tokenCheck.blockReason}`);
  }
  return denyOrAllow(config, "plan_check_denied", tokenCheck.blockReason);
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
      "policy_requires_approval",
      policyDecision.reason ||
        `ArmorClaude policy requires your approval before running ${toolName}.`
    );
  }
  if (!policyDecision.allowed) {
    return denyPreTool("policy_denied", policyDecision.reason || "ArmorClaude policy denied");
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

/** Wire fields conmap-auto reads at audit ingest. */
function withWouldBe(dto, wouldBe) {
  if (!wouldBe) return dto;
  return {
    ...dto,
    would_be: wouldBe.action,
    would_be_code: wouldBe.code ?? null,
    would_be_reason: redactSecrets(String(wouldBe.reason ?? "")).slice(0, 1000),
  };
}

function auditLink(config, sessionId, intentTokenRaw) {
  let planId;
  try {
    planId = JSON.parse(intentTokenRaw).planId;
  } catch {
    planId = undefined;
  }
  return {
    plan_id: planId,
    session_id: sessionId,
    user_id: config.userId,
    agent_id: config.agentId,
    client_id: config.mcpName || config.llmId,
  };
}

function pickStepIndex(plan, toolName, toolInput, unmatched = 0, used = new Set()) {
  if (!plan || typeof plan !== "object") return unmatched;
  const { matches, paramMatches } = findPlanStepIndices(plan, toolName, toolInput);
  const unused = (indices) => indices.find((i) => !used.has(i));
  return unused(paramMatches) ?? unused(matches) ?? paramMatches[0] ?? matches[0] ?? unmatched;
}

function auditedSteps(session, intentTokenRaw) {
  const tracker = session.auditedSteps;
  return tracker?.tokenHash === sha256Hex(intentTokenRaw) ? new Set(tracker.indices) : new Set();
}

async function claimAuditedStep(config, runtimeState, sessionId, toolName, inputs) {
  const session = getSession(runtimeState, sessionId);
  const used = auditedSteps(session, session.intentTokenRaw);
  const step = pickStepIndex(session.plan, toolName, inputs, null, used);
  if (step === null) return 0;
  used.add(step);
  upsertSession(runtimeState, sessionId, {
    auditedSteps: { tokenHash: sha256Hex(session.intentTokenRaw), indices: [...used] },
  });
  await saveRuntimeState(config.runtimeFile, runtimeState);
  return step;
}

function claimLoginNotice(runtimeState, sessionId, config) {
  if (!config.unconfigured || getSession(runtimeState, sessionId)?.loginNoticeShown) return false;
  upsertSession(runtimeState, sessionId, { loginNoticeShown: true });
  return true;
}

function notConnectedStart(config, loginNoticeDue) {
  const staleNote = config.hadUnusableKey
    ? "\n(The saved armorclaude key was ignored: it isn't a valid ArmorIQ key.)"
    : "";
  const notice = notSignedIn(config.backendEndpoint);
  return {
    ...(loginNoticeDue && { systemMessage: notice }),
    ...addPromptContext(
      `ArmorClaude installed but NOT connected.${staleNote}\n` +
        `Running in MONITOR mode: tool calls are not checked against a plan.\n\n` +
        `${notice}\n` +
        `Once you sign in, ArmorClaude enforces automatically.\n` +
        `Type /armorclaude:armor for all commands.`,
      "SessionStart"
    ),
  };
}

/**
 * Usage sync turns itself off when a key is missing or either opt-out is set,
 * and every call site then returns silently. Without this the session looks
 * connected and enforcing while no token usage ever reaches the dashboard.
 * Only reached once connected: notConnectedStart owns the unconfigured case.
 */
function usageSyncOffNotice(config) {
  if (config.usageSyncEnabled) return null;
  return (
    "ArmorClaude is connected and enforcing, but usage reporting is OFF, " +
    "so this session's tokens and cost will not appear on the dashboard.\n" +
    "Unset disable_usage_sync / disable_observability (or " +
    "ARMORIQ_USAGE_SYNC_DISABLED / ARMORIQ_OBSERVABILITY_DISABLED) to restore it."
  );
}

export async function handleSessionStart(input, config) {
  const result = await startSession(input, config);
  if (!input?.session_id) return result;
  const notice = await selfUpdateOnHook({
    cwd: typeof input.cwd === "string" ? input.cwd : undefined,
    dataDir: config.dataDir,
    check: true,
  });
  return withNotice(result, notice);
}

async function startSession(input, config) {
  await recoverRuns(input, config);
  await recordHookActivity(input, config);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const loginNoticeDue = claimLoginNotice(runtimeState, sessionId, config);
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
        syncNote =
          pulled.dropped === "restored"
            ? " This org has no dashboard policy, so your local policy is back in effect."
            : pulled.dropped === "dropped"
              ? " This org has no dashboard policy, so the policy from your previous org no longer applies."
              : ` Policy synced from dashboard (v${pulled.version}).`;
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

  // --- Not connected: installed but no usable API key. Show a clear setup
  // banner and run passively (monitor mode) instead of bricking the session.
  // This is the fresh `claude plugin install` path, which never ran the
  // interactive installer/onboarding. ---
  if (config.unconfigured) return notConnectedStart(config, loginNoticeDue);

  if (monitorAfterFetch(config)) return null;

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
      await writePrivateFile(onboardingFlag, new Date().toISOString());
    }
  }

  const policyState = await loadPolicyState(config.policyFile).catch((error) =>
    policyFileProblem(config, error)
  );
  if (policyState instanceof PolicyFileError) {
    return {
      systemMessage: policyState.message,
      ...addPromptContext(policyState.message, "SessionStart"),
    };
  }
  const intentLabel = intentMode(config, policyState.policy);
  const usageNote = usageSyncOffNotice(config);
  return {
    // systemMessage is what Claude Code prints to the person. Context alone
    // only reaches the model, which may never mention it.
    ...(usageNote && { systemMessage: usageNote }),
    ...addPromptContext(
      `ArmorClaude active (${modeLabel}, intent=${intentLabel})${syncNote}${onboardingMsg}` +
        (usageNote ? `\n\n${usageNote}` : ""),
      "SessionStart"
    ),
  };
}

export async function handleUserPromptExpansion(input, config) {
  await recordHookActivity(input, config);
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
  const result = await promptSubmit(input, config);
  if (!input?.session_id) return result;
  const notice = await selfUpdateOnHook({ dataDir: config.dataDir, check: false });
  return withNotice(result, notice);
}

async function promptSubmit(input, config) {
  await recordHookActivity(input, config);
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (typeof input.prompt !== "string" || !sessionId) {
    return null;
  }
  if (input.agent_id || input.parent_session_id || input.is_subagent) return null;
  await startPrompt(input, config);

  // --- /armor commands: human-only, policy-immune ---
  if (isArmorPolicyCommand(prompt)) {
    const response = await handleArmorPolicyCommand(prompt, config);
    return armorReply(response);
  }
  if (/^\s*\/(?:armor-policy|armorclaude:armor-policy)\b/i.test(prompt)) {
    return blockPrompt(legacyArmorPolicyMessage());
  }

  const policyState = await loadPolicyState(config.policyFile);
  const mode = intentMode(config, policyState.policy);
  const parts = [];
  if (config.planningEnabled && mode !== "optional") {
    const capture = mode === "capture";
    parts.push(
      (capture
        ? "ArmorClaude intent capture is active. Before the first tool that needs a plan, " +
          "declare your plan in this exact JSON shape so tool calls are recorded against it:\n\n"
        : "ArmorClaude intent enforcement is active. Before the first tool that needs a plan, " +
          "declare your plan in this exact JSON shape:\n\n") +
        INTENT_PLAN_FORMAT +
        "\n\n" +
        "How to submit:\n" +
        "Call the register_intent_plan tool (provided by the " +
        "armorclaude-policy MCP server; it may appear namespaced, e.g. " +
        "mcp__armorclaude-policy__register_intent_plan) with the JSON as the " +
        (capture
          ? "argument, as your first tool call that needs a plan. Chat only prompts need no plan.\n"
          : "argument before the first tool that needs one. Chat only prompts need no plan.\n") +
        "If that tool is not in your tool list, the ArmorClaude policy MCP " +
        "server is not connected: do not fabricate the call, and tell the " +
        "user to verify it with `claude mcp list` (expect armorclaude-policy " +
        (capture
          ? "Connected) so tool calls are recorded.\n"
          : "Connected) before relying on enforcement.\n") +
        (capture
          ? await captureNotice(config)
          : "Tool calls without a registered plan will be blocked.")
    );
  }
  if (parts.length > 0) {
    return addPromptContext(parts.join("\n\n"));
  }
  return null;
}

async function policyFileProblem(config, error) {
  if (!(error instanceof PolicyFileError)) throw error;
  const { appendDaemonLog } = await import("./daemon-log.mjs");
  appendDaemonLog(config.dataDir, `[armorclaude] error: ${error.message}`);
  return error;
}

export async function handlePreToolUse(input, config, runtimeState) {
  input.armorAudit ??= createAuditEnvelope(input);
  const session =
    getSession(runtimeState ?? (await loadRuntimeState(config.runtimeFile)), input.session_id) ||
    {};
  const ctx = {
    audit: input.armorAudit.contextCaptured
      ? input.armorAudit
      : snapshotAuditContext(input.armorAudit, session),
    plan: structuredClone(session.plan),
    generations: recordsPreToolActivity(input) ? await recordHookActivity(input, config) : null,
    runId: input.armorAudit.prompt_id || session.promptId,
  };
  let output;
  try {
    output = await decidePreToolUse(input, config, ctx).catch(async (error) => {
      const problem = await policyFileProblem(config, error);
      return denyOrAllow(config, "policy_file_invalid", problem.message);
    });
  } catch (error) {
    await recordRunTool(input, config, ctx.runId, ctx.runVerdict);
    throw error;
  }
  const generations = ctx.generations;
  if (generations) {
    const current = getSession(await loadRuntimeState(config.runtimeFile), input.session_id);
    if (!current || !sameGenerations(generations, current)) {
      const { policy } = await loadPolicyState(config.policyFile);
      if (!isFrictionlessAllowPolicy(policy))
        output = denyOrAllow(
          config,
          "intent_plan_missing",
          "ArmorClaude intent plan retired during tool check"
        );
    }
  }
  const code = output?.[DECISION_CODE];
  const source = policySource(code, ctx);
  const decision = output?.hookSpecificOutput?.permissionDecision;
  if (config.orgMonitor) {
    await recordRunTool(input, config, ctx.runId, ctx.runVerdict);
    return monitorPreToolUse(input, config, output, source, ctx.notice);
  }
  if (["deny", "ask"].includes(decision) && !ctx.backendAuditId) {
    await auditBlocked(input, withBackendPosture(config), code, ctx, source);
  }
  if (source && decision !== "deny") {
    _toolPolicySources.set(_toolTimingKey(input), source);
  }
  await recordRunTool(input, config, ctx.runId, ctx.runVerdict);
  if (!ctx.notice) return output;
  if (!output) return allowWithNotice(ctx.notice);
  return {
    ...output,
    systemMessage: [ctx.notice, output.systemMessage].filter(Boolean).join("\n\n"),
  };
}

function policySource(code, { v1, v2 }) {
  const local = v1 && {
    source: v1.matchedRule?.id ? "local" : "default",
    ...(v1.matchedRule?.id && { rule_id: v1.matchedRule.id }),
  };
  let source;
  if (code === "policy_v2_block" || code === "policy_v2_hold") source = v2?.source;
  else if (code === "policy_denied" || code === "policy_requires_approval") source = local;
  else if (code) source = { source: "builtin", rule_id: code };
  else source = v2?.source ?? local;
  if (!source) return null;
  return v2?.shadow?.length ? { ...source, shadow: v2.shadow } : source;
}

async function policyChangeNotice(config, sessionId, active) {
  if (!sessionId) return "";
  const key = active.map((p) => `${p.policyId}@${p.policyHash ?? ""}`).join(",");
  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const seen = getSession(runtimeState, sessionId)?.v2PolicyKey;
  if (seen === key) return "";
  upsertSession(runtimeState, sessionId, { v2PolicyKey: key });
  await saveRuntimeState(config.runtimeFile, runtimeState);
  if (seen === undefined) return "";
  return active.length
    ? `ArmorIQ policy updated: now enforcing ${active.map((p) => `"${p.name}"`).join(" and ")}.`
    : "ArmorIQ policy updated: no v2 policy is active, the local policy applies.";
}

async function logShadowVerdicts(config, toolName, shadow) {
  const flagged = (shadow ?? []).filter((s) => s.verdict !== "allow");
  if (!flagged.length) return;
  const { appendDaemonLog } = await import("./daemon-log.mjs");
  for (const s of flagged) {
    appendDaemonLog(
      config.dataDir,
      `[armorclaude] shadow: policy "${s.policy_name}" would ${s.verdict} ${toolName} (not enforced)`
    );
  }
}

function withPolicySource(inputs, source) {
  return source ? { ...(isPlainObject(inputs) ? inputs : {}), armoriq_policy: source } : inputs;
}

const MONITOR_NOTE = {
  deny: "ArmorIQ would block this call in Enforce",
  ask: "ArmorIQ would ask for approval here in Enforce",
};

function monitorNote(decision, reason) {
  const why = String(reason ?? "")
    .split("\n")[0]
    .slice(0, 200);
  return `${MONITOR_NOTE[decision]}${why ? ` (${why})` : ""}. Monitor let it run.`;
}

async function monitorPreToolUse(input, config, output, source, notice) {
  const decision = output?.hookSpecificOutput?.permissionDecision;
  if (source) _toolPolicySources.set(_toolTimingKey(input), source);
  if (decision !== "deny" && decision !== "ask") return notice ? allowWithNotice(notice) : null;
  const reason = output.hookSpecificOutput.permissionDecisionReason;
  await rememberWouldBe(config.dataDir, input, {
    action: decision === "deny" ? "block" : "hold",
    code: output[DECISION_CODE],
    reason,
    ...(source && { source }),
  }).catch((err) => debugLog(config, `would-be record failed: ${err?.message ?? err}`));
  const notes = [notice, config.orgMonitorNotices && monitorNote(decision, reason)].filter(Boolean);
  return notes.length ? allowWithNotice(notes.join("\n\n")) : null;
}

async function auditBlocked(input, config, code, activity, source) {
  if (!config.auditEnabled || !config.apiKey) return;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const toolName =
    typeof input.tool_name === "string" && input.tool_name ? input.tool_name : "unknown";
  try {
    const snapshot = activity.audit;
    const inputs = sanitizeParams(input.tool_input, config.sanitize);
    const decision = decisionCode(code);
    const dto = {
      ...auditLink(config, sessionId, ""),
      client_row_id: snapshot.decisionId,
      plan_id: snapshot.plan_id,
      context_plan_id: snapshot.context_plan_id,
      prompt_id: snapshot.prompt_id,
      step_index: pickStepIndex(activity.plan, toolName, inputs, -1),
      action: toolName,
      tool: toolName,
      input: withPolicySource(redactSecrets(inputs), source),
      output:
        source?.source === "v2"
          ? {
              matchedPolicy: {
                policyId: source.policy_id,
                name: source.policy_name,
                policyVersion: source.policy_hash,
              },
              reason: activity.v2?.reason,
            }
          : null,
      status: decision === "approval_required" ? "held" : "blocked",
      decision_code: decision,
      error_message: code,
      executed_at: snapshot.executed_at,
      duration_ms: 0,
    };
    const target = await emitAudit({ dto, config });
    debugLog(config, `audit log (blocked) ${target} for ${toolName}`);
  } catch (error) {
    debugLog(config, `audit log (blocked) failed: ${error}`);
    throw error;
  }
}

async function sessionPlanCheck(config, sessionId) {
  const file = planCheckFile(config.runtimeFile, sessionId);
  if (!file) return null;
  for (const pendingPath of [
    path.join(config.dataDir, `pending-plan.${sessionId}.json`),
    path.join(config.dataDir, "pending-plan.json"),
  ]) {
    const pending = await readJson(pendingPath, null);
    if (pending && (pending.tokenRaw || pending.plan)) {
      return pending.intentPolicyCompilerVersion === INTENT_POLICY_COMPILER_VERSION
        ? tokenPlanCheck(pending.tokenRaw)
        : null;
    }
  }
  return readJson(file, null);
}

async function decidePreToolUse(input, config, ctx = {}) {
  // Record start timestamp BEFORE any deny/early-return so even denied calls
  // have timing data available for PostToolUse/PostToolUseFailure.
  _recordToolStart(input);

  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = sanitizeParams(input.tool_input, config.sanitize);
  if (!toolName) {
    // Missing tool_name on a PreToolUse event means the payload shape is
    // unexpected. Fail-closed in enforce mode instead of silently allowing.
    return denyOrAllow(config, "missing_tool_name", "ArmorClaude: missing tool_name on PreToolUse");
  }

  // Never block ArmorClaude's own MCP tools, or the agent cannot register the plan
  // that unblocks it. Match the exact .mcp.json prefix (armorclaude-policy), not a
  // suffix, so a server named evil__policy_update is not allowlisted.
  const norm = normalizeToolName(toolName);
  const armorTools = [
    "register_intent_plan",
    "policy_read",
    "trust_revoke",
    "trust_reanchor",
    "trust_delegate",
  ];
  // Claude Code prefixes MCP tools differently for .mcp.json and plugin-loaded
  // servers. Missing either variant deadlocks the session on register_intent_plan.
  const armorMcpPrefixes = [
    "mcp__armorclaude-policy__",
    "mcp__plugin_armorclaude_armorclaude-policy__",
  ];
  if (armorTools.some((t) => norm === t || armorMcpPrefixes.some((pfx) => norm === `${pfx}${t}`))) {
    return null;
  }

  // Denying /armorclaude:armor under default-deny locks the user out of the
  // command that fixes the policy. Tools the skill runs are still checked.
  if (norm === "skill") {
    const skillRef = String(toolInput?.skill ?? toolInput?.name ?? "")
      .trim()
      .toLowerCase();
    if (skillRef === "armor" || skillRef === "armorclaude:armor" || skillRef.endsWith(":armor")) {
      return null;
    }
  }

  // --- Path guard: block write operations targeting policy/credential files.
  //     Read operations (cat, Read tool) are allowed --- only mutations blocked.
  const PROTECTED_PATHS = [
    config.dataDir,
    config.policyFile,
    config.runtimeFile,
    path.join(homedir(), ".armoriq", "credentials.json"),
  ];
  const sessionCwd = typeof input.cwd === "string" && input.cwd ? input.cwd : null;
  if (["write", "edit", "notebookedit"].includes(norm)) {
    const target = toolInput?.file_path || toolInput?.notebook_path || toolInput?.path || "";
    const resolved =
      typeof target === "string" && target && (path.isAbsolute(target) || sessionCwd)
        ? path.resolve(sessionCwd ?? "/", target)
        : null;
    if (
      typeof target === "string" &&
      target &&
      ((resolved && isProtectedPath(resolved, PROTECTED_PATHS)) ||
        target.includes("armorclaude/policy") ||
        target.includes("armorclaude/profiles"))
    ) {
      return denyPreTool(
        "protected_policy_file",
        "ArmorClaude: direct modification of ArmorClaude policy, state or credential files is blocked. Use /armorclaude:armor policy commands."
      );
    }
  }
  if (norm === "bash") {
    const cmd = typeof toolInput?.command === "string" ? toolInput.command : "";
    if (invokesPolicyAdmin(cmd)) {
      return denyPreTool(
        "policy_admin_command",
        "ArmorClaude: policy management is human-only. Type /armorclaude:armor policy in the terminal."
      );
    }
    if (writesProtectedPath(cmd, sessionCwd, PROTECTED_PATHS)) {
      return denyPreTool(
        "protected_policy_file",
        "ArmorClaude: shell commands that write, move or delete ArmorClaude policy, state or credential files are blocked. Use /armorclaude:armor policy commands."
      );
    }
  }

  // Side-effect-free tools skip the pipeline. Bash, Edit, Write and NotebookEdit
  // must never be added here: they mutate state and would bypass enforcement.
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

  // --- Policy v2: the org's verdict for this exact call, from the raw input
  //     (sanitizeParams truncates long values, which a rule could miss). ---
  const v2 = config.apiKey ? await decideV2(config, toolName, input.tool_input) : null;
  ctx.v2 = v2;
  ctx.runVerdict = v2;
  if (v2?.code === "backend_unreachable") return denyPreTool("backend_unreachable", v2.reason);
  if (v2?.reason === "signed_out") config = localOnly(config);
  if (v2?.active) ctx.notice = await policyChangeNotice(config, sessionId, v2.active);
  await logShadowVerdicts(config, toolName, v2?.shadow);
  if (v2?.action === "block") {
    const policy = v2.matchedPolicy ? ` "${v2.matchedPolicy}"` : "";
    const reason = `ArmorIQ policy${policy} blocked ${toolName} (${v2.reason})`;
    if (shouldDeny(config)) return denyPreTool("policy_v2_block", reason);
    const { appendDaemonLog } = await import("./daemon-log.mjs");
    appendDaemonLog(config.dataDir, `[armorclaude] monitor: ${reason}`);
  }

  const readOnlyPolicyTools = new Set(["read", "grep", "glob", "websearch", "webfetch"]);
  if (readOnlyPolicyTools.has(norm) && v2?.action !== "hold") {
    const safePolicyState = await loadPolicyState(config.policyFile);
    const safePolicyDecision = await evaluateConfiguredPolicy(
      config,
      safePolicyState,
      toolName,
      toolInput
    );
    ctx.v1 = safePolicyDecision;
    const safePolicyOutput = preToolPolicyOutput(safePolicyDecision, toolName);
    const policyDecision = safePolicyOutput?.hookSpecificOutput?.permissionDecision;
    if (policyDecision === "deny" || isFrictionlessAllowPolicy(safePolicyState.policy))
      return safePolicyOutput;
    const denial = planCheckDenial(await sessionPlanCheck(config, sessionId), toolName);
    const blocked =
      denial && (await tokenBlocked(config, { planCheckDenied: true, blockReason: denial }));
    return blocked || safePolicyOutput;
  }

  if (!ctx.generations) ctx.generations = await recordHookActivity(input, config);

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
          "mcp_server_denied",
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
  if (!pending && !getSession(runtimeState, sessionId)?.promptId) {
    pending = await readJson(legacyPendingPath, null);
    pendingPath = legacyPendingPath;
  }
  const pendingSession = getSession(runtimeState, sessionId);
  if (
    pending &&
    (pendingSession?.promptId ||
      pendingSession?.authGeneration > 0 ||
      pending.promptGeneration !== undefined ||
      pending.authGeneration !== undefined) &&
    (!sameGenerations(pending, pendingSession) || pending.sessionId !== sessionId)
  ) {
    await unlink(pendingPath).catch(() => {});
    pending = null;
  }
  if (pending?.tokenRaw && pendingSession?.promptId) {
    await unlink(pendingPath).catch(() => {});
    pending = null;
  }
  if (pending && (pending.tokenRaw || pending.plan)) {
    const pendingPolicyState = await loadPolicyState(config.policyFile);
    const pendingPolicyHash = computePolicyHash(pendingPolicyState.policy);
    // Sign the ReAnchor delta before overwriting the cached plan, or the
    // audit log shows orphan Commits.
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
            // The local sha256 differs from the CSRG canonical hash and cannot be
            // matched against backend trust_deltas, so prefer the token's planHash.
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
      planCaptured: false,
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
  // "All Allow" policy (including no confirmed policy) => intent is captured
  // but never blocks: no plan gate, no drift, expiry or proof denies. Any
  // policy with a deny/require_approval keeps full enforcement.
  const allowAll = isFrictionlessAllowPolicy(policyState.policy);
  const enforceIntent = config.intentRequired && !allowAll;

  // Crypto policy digest check
  if (config.cryptoPolicyEnabled) {
    try {
      const { createCryptoPolicyService } = await import("./crypto-policy.mjs");
      const cryptoService = createCryptoPolicyService(config);
      const cachedState = await cryptoService.loadCachedState();
      if (cachedState?.policyDigest) {
        const check = cryptoService.verifyPolicyDigest(currentPolicyHash, cachedState.policyDigest);
        if (!check.valid) {
          return denyOrAllow(
            config,
            "crypto_policy_mismatch",
            `ArmorClaude crypto policy mismatch: ${check.reason}`
          );
        }
      }
    } catch (error) {
      debugLog(config, `crypto policy check error: ${error}`);
    }
  }

  // --- Policy evaluation: dispatch based on enforcement engine ---
  let policyDecision = await evaluateConfiguredPolicy(config, policyState, toolName, toolInput);
  ctx.v1 = policyDecision;
  const requiresUserApproval = policyDecisionRequiresApproval(policyDecision);
  if (!policyDecision.allowed && !requiresUserApproval) {
    return denyPreTool("policy_denied", policyDecision.reason || "ArmorClaude policy denied");
  }

  // --- Intent token verification ---
  // Reuse the runtimeState loaded above instead of re-reading from disk.
  let session = getSession(runtimeState, sessionId) || {};
  if (!ctx.audit.prompt_id) {
    ctx.audit = snapshotAuditContext(input.armorAudit, session);
    ctx.plan = structuredClone(session.plan);
  }
  if (invalidateTokenOnKeyChange(session, config)) {
    debugLog(config, "API key changed (prefix differs); discarded cached intent token");
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
  let billingDegraded =
    session.unregisteredLocalPlan?.reason === "billing" &&
    isBillingError(`402 ${session.unregisteredLocalPlan.message}`);
  let localExpiresAt = session.expiresAt;
  let remoteAllowed = false;
  let tokenCheckMatched = false;
  let usedStepIndices =
    intentTokenRaw && localPlan
      ? getSessionTokenUsedStepIndices(session, intentTokenRaw)
      : undefined;

  if (intentTokenRaw && session.countedPlanId && Date.parse(session.tokenExpiresAt) <= Date.now()) {
    await refreshIntent(config, sessionId, { expiredOnly: true });
    const current = getSession(await loadRuntimeState(config.runtimeFile), sessionId);
    if (current && sameGenerations(session, current)) {
      session = upsertSession(runtimeState, sessionId, current);
      intentTokenRaw = session.intentTokenRaw || "";
      localPlan = session.plan;
      billingDegraded = session.unregisteredLocalPlan?.reason === "billing";
      localExpiresAt = session.expiresAt;
      usedStepIndices =
        intentTokenRaw && localPlan
          ? getSessionTokenUsedStepIndices(session, intentTokenRaw)
          : undefined;
      ctx.audit = snapshotAuditContext(input.armorAudit, session);
      ctx.plan = structuredClone(session.plan);
    }
  }

  if (!intentTokenRaw && config.apiKey && !allowAll && enforceIntent && shouldDeny(config)) {
    if (isPlainObject(localPlan) && (!session.promptId || billingDegraded)) {
      const preMintCheck = checkToolAgainstPlan({
        plan: localPlan,
        toolName,
        toolInput,
        strict: !!config.strictParamCheck,
      });
      if (!preMintCheck.allowed) {
        return denyPreToolWithHint(
          "intent_drift",
          preMintCheck.reason || "ArmorClaude intent drift",
          {
            toolName,
            toolInput,
            goal: session.lastPrompt,
            knownPlan: localPlan,
          }
        );
      }
    } else {
      return denyPreToolWithHint(
        "intent_plan_missing",
        "ArmorClaude intent plan missing for this session",
        {
          toolName,
          toolInput,
          goal: session.lastPrompt,
        }
      );
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
      if (tokenCheck.blockReason && !allowAll) {
        return tokenBlocked(config, tokenCheck);
      }
      localPlan = tokenCheck.plan || localPlan;
      remoteAllowed = true;
    }
  }

  // --- CSRG proof handling ---
  const parsedProofs = parseCsrgProofHeaders(input);
  if (parsedProofs.error && !allowAll) {
    return denyOrAllow(config, "csrg_proof_invalid", parsedProofs.error);
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
  if (proofError && !allowAll) {
    return denyOrAllow(config, "csrg_proof_rejected", proofError);
  }

  // --- Remote step verification ---
  if (intentTokenRaw && config.verifyStepEndpoint && config.csrgVerifyEnabled) {
    try {
      const iapService = createIapService(config);
      const verifyResult = await iapService.verifyStep(intentTokenRaw, csrgProofs, toolName);
      if (!verifyResult.skipped) {
        remoteAllowed = verifyResult.allowed === true;
      }
      if (verifyResult.allowed === false && !allowAll) {
        return denyOrAllow(
          config,
          "remote_verify_denied",
          formatRemoteVerifyDeny(toolName, verifyResult)
        );
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
      const deny =
        !allowAll &&
        denyOrAllow(config, "remote_verify_failed", `ArmorClaude verify-step failed: ${message}`);
      if (deny) {
        return deny;
      }
    }
  }

  // --- Expiry check ---
  if (
    !allowAll &&
    Number.isFinite(localExpiresAt) &&
    localExpiresAt > 0 &&
    Date.now() / 1000 >= localExpiresAt
  ) {
    const deny = denyOrAllow(
      config,
      "intent_token_expired",
      "ArmorClaude intent token expired — call register_intent_plan with your current plan to refresh, then retry the tool"
    );
    if (deny) {
      return deny;
    }
  }

  // --- Local plan enforcement (no backend / no token) ---
  // When a plan was registered via register_intent_plan but ArmorIQ is not
  // configured, enforce the plan locally: tool must be in plan, and params
  // (if declared in step.arguments) must match.
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
      if (shouldDeny(config) && !allowAll) {
        return denyPreToolWithHint(
          "intent_drift",
          localCheck.reason || "ArmorClaude intent drift",
          {
            toolName,
            toolInput,
            goal: session.lastPrompt,
            knownPlan: localPlan,
          }
        );
      }
    }
  }

  // --- Enforce intent requirement ---
  if (enforceIntent && !remoteAllowed && !tokenCheckMatched && !localPlanMatched) {
    if (shouldDeny(config)) {
      return denyPreToolWithHint(
        "intent_plan_missing",
        "ArmorClaude intent plan missing for this session",
        {
          toolName,
          toolInput,
          goal: session.lastPrompt,
        }
      );
    }
    const deny = denyOrAllow(
      config,
      "intent_plan_missing",
      "ArmorClaude intent plan missing for this session"
    );
    if (deny) {
      return deny;
    }
  }

  // --- Record tool for discovery ---
  upsertDiscoveredTool(runtimeState, toolName);
  await saveRuntimeState(config.runtimeFile, runtimeState);
  if (v2?.action === "hold" && config.orgMonitor) return askPreTool("policy_v2_hold", v2.reason);
  if (v2?.action === "hold") {
    const v2Session = getSession(runtimeState, sessionId) || {};
    const held = await resolveV2Hold(config, {
      intentTokenRaw,
      toolName,
      toolArgs: input.tool_input,
      session: v2Session,
      policyName: v2.matchedPolicy,
      audit: ctx.audit,
    });
    if (v2Session.v2Delegations) {
      upsertSession(runtimeState, sessionId, { v2Delegations: v2Session.v2Delegations });
      await saveRuntimeState(config.runtimeFile, runtimeState);
    }
    if (held.action === "block" && shouldDeny(config)) {
      ctx.backendAuditId = held.auditId;
      return denyPreTool("policy_v2_block", held.reason);
    }
    if (held.action === "hold") {
      ctx.backendAuditId = held.auditId;
      return denyPreTool("policy_v2_hold", held.reason);
    }
  }
  if (mcpApprovalReason) {
    return askPreTool("mcp_server_unapproved", mcpApprovalReason);
  }
  if (requiresUserApproval) {
    const askReason =
      policyDecision.reason ||
      `ArmorClaude policy requires your approval before running ${toolName}.`;
    return askPreTool("policy_requires_approval", askReason);
  }
  if (billingDegraded && !session.billingNoticeShown) {
    upsertSession(runtimeState, sessionId, { billingNoticeShown: true });
    await saveRuntimeState(config.runtimeFile, runtimeState);
    return allowWithNotice(
      `ArmorIQ billing has paused remote audit and CSRG proofs. Your policy is still enforced locally. Upgrade: ${billingUpgradeUrl(config)}`
    );
  }
  return null;
}

export async function handlePostToolUse(input, config) {
  const policySourceOfCall = takePolicySource(input);
  input.armorAudit ??= createAuditEnvelope(input);
  await recordHookActivity(input, config);
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
    const snapshot = input.armorAudit.contextCaptured
      ? input.armorAudit
      : snapshotAuditContext(input.armorAudit, session);
    const intentTokenRaw = session.intentTokenRaw || "";
    const inputs = sanitizeParams(input.tool_input, config.sanitize);
    const wouldBe = config.orgMonitor ? await takeWouldBe(config.dataDir, input) : null;

    let dto;
    if (intentTokenRaw) {
      const stepIdx = await claimAuditedStep(config, runtimeState, sessionId, toolName, inputs);
      dto = {
        ...auditLink(config, sessionId, intentTokenRaw),
        step_index: stepIdx,
        action: toolName,
        tool: toolName,
        input: withPolicySource(redactSecrets(inputs), policySourceOfCall),
        output: redactSecrets(sanitizeParams(input.tool_response, config.sanitize)),
        status: "success",
        executed_at: new Date().toISOString(),
        duration_ms: _computeToolDuration(input),
      };
    } else {
      if (
        !config.orgMonitor &&
        !isFrictionlessAllowPolicy((await loadPolicyState(config.policyFile)).policy)
      )
        return null;
      dto = {
        session_id: sessionId,
        user_id: config.userId,
        agent_id: config.agentId,
        client_id: config.mcpName || config.llmId,
        step_index: -1,
        action: toolName,
        tool: toolName,
        input: withPolicySource(redactSecrets(inputs), policySourceOfCall),
        output: redactSecrets(sanitizeParams(input.tool_response, config.sanitize)),
        status: "success",
        executed_at: new Date().toISOString(),
        duration_ms: _computeToolDuration(input),
      };
    }

    Object.assign(dto, {
      client_row_id: snapshot.resultId,
      plan_id: snapshot.plan_id,
      context_plan_id: snapshot.context_plan_id,
      prompt_id: snapshot.prompt_id,
      executed_at: snapshot.executed_at,
    });

    // Returning before the durable receipt can lose the only result row when the hook exits.
    const target = await emitAudit({ dto: withWouldBe(dto, wouldBe), config });
    debugLog(config, `audit log ${target} for ${toolName}`);
  } catch (error) {
    // A result capture failure cannot deny a call that already ran.
    debugLog(config, `audit log failed: ${error}`);
    if (!error.captureFailureRecorded) await recordCaptureFailure(config.dataDir, "internal_error");
  }

  return null;
}

export async function handlePostToolUseFailure(input, config) {
  const policySourceOfCall = takePolicySource(input);
  input.armorAudit ??= createAuditEnvelope(input);
  await recordHookActivity(input, config);
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
    const intentTokenRaw = session.intentTokenRaw || "";
    const wouldBe = config.orgMonitor ? await takeWouldBe(config.dataDir, input) : null;
    if (!intentTokenRaw && !config.orgMonitor) return null;

    const inputs = sanitizeParams(input.tool_input, config.sanitize);
    const used = auditedSteps(session, intentTokenRaw);
    const stepIdx = intentTokenRaw ? pickStepIndex(session.plan, toolName, inputs, 0, used) : -1;
    const snapshot = input.armorAudit.contextCaptured
      ? input.armorAudit
      : snapshotAuditContext(input.armorAudit, session);
    const dto = {
      ...auditLink(config, sessionId, intentTokenRaw),
      client_row_id: snapshot.resultId,
      plan_id: snapshot.plan_id,
      context_plan_id: snapshot.context_plan_id,
      prompt_id: snapshot.prompt_id,
      step_index: stepIdx,
      action: toolName,
      tool: toolName,
      input: withPolicySource(redactSecrets(inputs), policySourceOfCall),
      output: null,
      status: "failed",
      error_message: typeof input.error === "string" ? redactSecrets(input.error) : "Unknown error",
      executed_at: snapshot.executed_at,
      duration_ms: _computeToolDuration(input),
    };

    const target = await emitAudit({ dto: withWouldBe(dto, wouldBe), config });
    debugLog(config, `audit log (failure) ${target} for ${toolName}`);
  } catch (error) {
    debugLog(config, `audit log (failure) failed: ${error}`);
    if (!error.captureFailureRecorded) await recordCaptureFailure(config.dataDir, "internal_error");
  }

  return null;
}

function retiredCallback(input, session) {
  const captured = input.armorAudit;
  return (
    Boolean(captured?.contextCaptured || captured?.prompt_id) &&
    captured.prompt_id !== session?.promptId
  );
}

export async function handleStop(input, config) {
  await recordHookActivity(input, config);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;

  const closed = await updateRuntimeState(config.runtimeFile, (state) => {
    if (
      !input.agent_id &&
      !input.parent_session_id &&
      !input.is_subagent &&
      getSession(state, sessionId)
    ) {
      if (retiredCallback(input, state.sessions[sessionId])) return false;
      const session = upsertSession(state, sessionId, { promptOpenSince: null });
      if (session.pendingRequest?.headers?.["X-ArmorIQ-Plan-Kind"] === "refresh")
        session.pendingRequest = null;
      return { runId: input.armorAudit?.prompt_id || session.promptId };
    }
    return false;
  });
  if (!closed) return null;
  await updateRunState(config, (state) => closeRun(state, closed.runId, "stop"));

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const session = getSession(runtimeState, sessionId);
  if (!session || retiredCallback(input, session)) return null;

  // Check if token expired mid-turn
  if (Number.isFinite(session.expiresAt) && nowEpochSeconds() > session.expiresAt) {
    debugLog(config, "intent token expired during turn");
  }

  upsertSession(runtimeState, sessionId, { lastStopAt: nowEpochSeconds() });
  await saveRuntimeState(config.runtimeFile, runtimeState);
  return null;
}

export async function handleSessionEnd(input, config) {
  await recordHookActivity(input, config);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return null;
  await dropWouldBe(config.dataDir, sessionId).catch(() => {});
  if (input.agent_id || input.parent_session_id || input.is_subagent) return null;
  const closed = await updateRuntimeState(config.runtimeFile, (state) => {
    if (retiredCallback(input, state.sessions[sessionId])) return false;
    return { runId: input.armorAudit?.prompt_id || state.sessions[sessionId]?.promptId };
  });
  if (!closed) return null;
  await updateRunState(config, (state) => closeRun(state, closed.runId, "session_end"));

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const session = runtimeState.sessions ? runtimeState.sessions[sessionId] : undefined;
  if (retiredCallback(input, session)) return null;

  // Revoke at session end so the token cannot outlive the session.
  if (config.autoRevokeOnEnd && session?.intentTokenRaw) {
    if (!Number.isFinite(session.expiresAt) || session.expiresAt > nowEpochSeconds()) {
      let intentToken = null;
      try {
        intentToken = JSON.parse(session.intentTokenRaw);
      } catch {
        intentToken = null;
      }
      // Started, not awaited: Claude Code cancels a SessionEnd hook after about 1.5 s, and a revoke
      // round trip to the backend can take that long. The daemon finishes it after replying.
      revokeViaSdk({
        getClient: getSdkClient,
        config,
        intentToken,
        reason: "armorclaude:session-ended",
        cascade: false,
      })
        .then((result) =>
          debugLog(
            config,
            `[trust] session-end revoke ${result.ok ? "ok" : "failed"} trustId=${result.trustId || "n/a"}`
          )
        )
        .catch(() => undefined);
    }
  }

  if (runtimeState.sessions && runtimeState.sessions[sessionId]) {
    delete runtimeState.sessions[sessionId];
  }
  await saveRuntimeState(config.runtimeFile, runtimeState);

  debugLog(config, `session ended: ${sessionId}`);
  return null;
}
