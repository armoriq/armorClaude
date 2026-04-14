import { normalizeToolName, nowEpochSeconds, sanitizeParams } from "./common.mjs";
import { addPromptContext, blockPrompt, denyPreTool } from "./hook-output.mjs";
import {
  checkIntentTokenPlan,
  extractAllowedActions,
  getSessionTokenUsedStepIndices,
  parseCsrgProofHeaders,
  recordSessionTokenUsedStepIndices,
  requestIntent,
  resolveCsrgProofsFromToken,
  validateCsrgProofHeaders
} from "./intent.mjs";
import { createIapService } from "./iap-service.mjs";
import {
  applyPolicyCommand,
  computePolicyHash,
  evaluatePolicy,
  loadPolicyState,
  parsePolicyTextCommand
} from "./policy.mjs";
import { INTENT_PLAN_FORMAT, INTENT_PLAN_ZOD, normalizeIntentPlan } from "./intent-schema.mjs";
import {
  extractPlanJsonBlock,
  parsePlanFile,
  resolvePlanFilePath
} from "./planner.mjs";
import { readJson } from "./fs-store.mjs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import {
  getDiscoveredTools,
  getSession,
  loadRuntimeState,
  saveRuntimeState,
  upsertDiscoveredTool,
  upsertSession
} from "./runtime-state.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shouldDeny(config) {
  return config.mode === "enforce";
}

function buildPolicyContextHints() {
  return [
    "ArmorCowork policy instructions:",
    "- If the user explicitly asks to change policy, call `policy_update` immediately.",
    "- Supported text commands: Policy list/get/delete/reset/update/new/prioritize.",
    "- Do not invent extra policy mechanisms outside `policy_update`."
  ].join("\n");
}

function actorCandidates(input) {
  const out = [];
  for (const key of ["session_id", "user_id", "actor_id", "cwd"]) {
    const value = input && typeof input[key] === "string" ? input[key].trim() : "";
    if (value) {
      out.push(value);
    }
  }
  return out;
}

function policyCommandLooksLikePrompt(prompt) {
  return typeof prompt === "string" && /^\s*policy\b/i.test(prompt);
}

function isPolicyUpdateAllowed(config, input) {
  if (!config.policyUpdateEnabled) {
    return { allowed: false, reason: "ArmorCowork policy updates disabled" };
  }
  const allowList = config.policyUpdateAllowList;
  if (!Array.isArray(allowList) || allowList.length === 0 || allowList.includes("*")) {
    return { allowed: true };
  }
  const candidates = actorCandidates(input);
  const allowed = candidates.some((entry) => allowList.includes(entry));
  return allowed
    ? { allowed: true }
    : {
        allowed: false,
        reason: "ArmorCowork policy update denied",
        candidates
      };
}

function mergeIntentIntoSession(session, intentResponse) {
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
  return next;
}

function readIntentTokenRaw(input, session) {
  const candidates = [
    input.intentTokenRaw,
    input.intent_token_raw,
    input.intent_token,
    input.intentToken,
    session.intentTokenRaw
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

function debugLog(config, message) {
  if (config.debug) {
    process.stderr.write(`[armorcowork] ${message}\n`);
  }
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
    discoveredTools: []
  });
  await saveRuntimeState(config.runtimeFile, runtimeState);

  debugLog(config, `session started: ${sessionId}, mode=${config.mode}`);

  const modeLabel = config.mode === "enforce" ? "ENFORCING" : "MONITORING";
  const intentLabel = config.intentRequired ? "required" : "optional";
  return addPromptContext(
    `ArmorCowork active (${modeLabel}, intent=${intentLabel})`
  );
}

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------

export async function handleUserPromptSubmit(input, config) {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!prompt || !sessionId) {
    return null;
  }

  // --- Policy command handling ---
  if (policyCommandLooksLikePrompt(prompt)) {
    const allowed = isPolicyUpdateAllowed(config, input);
    if (!allowed.allowed) {
      return blockPrompt(allowed.reason || "ArmorCowork policy update denied");
    }
    const policyState = await loadPolicyState(config.policyFile);
    const command = parsePolicyTextCommand(prompt, policyState);
    const actor = actorCandidates(input)[0] || "unknown";
    const result = await applyPolicyCommand({
      policyFilePath: config.policyFile,
      state: policyState,
      command,
      actor
    });
    return blockPrompt(result.message);
  }

  // --- Store prompt in session ---
  const runtimeState = await loadRuntimeState(config.runtimeFile);
  upsertSession(runtimeState, sessionId, {
    lastPrompt: prompt,
    lastPromptAt: nowEpochSeconds()
  });
  await saveRuntimeState(config.runtimeFile, runtimeState);

  // --- Inject directive: tell Claude to register its intent plan ---
  // Claude will call the `register_intent_plan` MCP tool (or include a JSON
  // block in its plan file) as its first action. This uses the session's own
  // LLM — no separate API key or extra LLM call needed.
  const parts = [];
  if (config.planningEnabled) {
    parts.push(
      "ArmorCowork intent enforcement is active. Before using any tool, " +
      "declare your plan in this exact JSON shape:\n\n" +
      INTENT_PLAN_FORMAT + "\n\n" +
      "How to submit:\n" +
      "- If in plan mode: include the JSON block (fenced with ```json) " +
      "at the end of your plan file.\n" +
      "- Otherwise: call `register_intent_plan` with the JSON as the " +
      "argument BEFORE any other tool call.\n" +
      "Tool calls without a registered plan will be blocked."
    );
  }
  if (config.contextHintsEnabled && config.policyUpdateEnabled) {
    parts.push(buildPolicyContextHints());
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
    return null;
  }

  // --- Whitelist: always allow the plan-registration tool itself ---
  const norm = normalizeToolName(toolName);
  if (
    norm === "register_intent_plan" ||
    norm.endsWith("__register_intent_plan")
  ) {
    return null;
  }

  // --- ExitPlanMode interception: capture the plan ---
  if (norm === "exitplanmode") {
    return await handleExitPlanModeCapture(input, sessionId, config);
  }

  // --- Consume pending plan from register_intent_plan MCP tool ---
  const runtimeStateEarly = await loadRuntimeState(config.runtimeFile);
  const sessionEarly = getSession(runtimeStateEarly, sessionId) || {};
  if (!sessionEarly.intentTokenRaw && !sessionEarly.plan) {
    const pendingPath = path.join(config.dataDir, "pending-plan.json");
    const pending = await readJson(pendingPath, null);
    if (pending && (pending.tokenRaw || pending.plan)) {
      upsertSession(runtimeStateEarly, sessionId, {
        intentTokenRaw: pending.tokenRaw || "",
        plan: pending.plan,
        allowedActions: Array.isArray(pending.allowedActions) ? pending.allowedActions : [],
        expiresAt: pending.expiresAt
      });
      await saveRuntimeState(config.runtimeFile, runtimeStateEarly);
      await unlink(pendingPath).catch(() => {});
      debugLog(config, "consumed pending plan from register_intent_plan");
    }
  }

  // --- Static policy evaluation ---
  const policyState = await loadPolicyState(config.policyFile);

  // Crypto policy digest check (Phase 4 integration point)
  if (config.cryptoPolicyEnabled) {
    try {
      const { createCryptoPolicyService } = await import("./crypto-policy.mjs");
      const cryptoService = createCryptoPolicyService(config);
      const currentDigest = computePolicyHash(policyState.policy);
      const cachedState = await cryptoService.loadCachedState();
      if (cachedState?.policyDigest) {
        const check = cryptoService.verifyPolicyDigest(currentDigest, cachedState.policyDigest);
        if (!check.valid) {
          return denyOrAllow(config, `ArmorCowork crypto policy mismatch: ${check.reason}`);
        }
      }
    } catch (error) {
      debugLog(config, `crypto policy check error: ${error}`);
    }
  }

  const policyDecision = evaluatePolicy({
    policy: policyState.policy,
    toolName,
    toolParams: toolInput
  });
  if (!policyDecision.allowed) {
    return denyPreTool(policyDecision.reason || "ArmorCowork policy denied");
  }

  // --- Intent token verification ---
  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const session = getSession(runtimeState, sessionId) || {};
  let intentTokenRaw = readIntentTokenRaw(input, session);
  let localPlan = session.plan;
  let localExpiresAt = session.expiresAt;
  let remoteAllowed = false;
  let tokenCheckMatched = false;
  let usedStepIndices =
    intentTokenRaw && localPlan
      ? getSessionTokenUsedStepIndices(session, intentTokenRaw)
      : undefined;

  // If no token, try to acquire one
  if (!intentTokenRaw && (config.intentEndpoint || (config.useSdkIntent && config.apiKey))) {
    try {
      const policyHash = computePolicyHash(policyState.policy);
      const intentResponse = await requestIntent(config, {
        prompt: session.lastPrompt || `Use tool ${toolName}`,
        session_id: sessionId,
        toolName,
        toolInput,
        policy_hash: policyHash,
        policy: policyState.policy,
        validitySeconds: config.validitySeconds,
        metadata: {
          source: "claude-code",
          trigger: "pre_tool_use"
        }
      });
      const merged = mergeIntentIntoSession(session, intentResponse);
      upsertSession(runtimeState, sessionId, merged);
      intentTokenRaw =
        typeof merged.intentTokenRaw === "string" ? merged.intentTokenRaw : "";
      localPlan = merged.plan || localPlan;
      localExpiresAt = merged.expiresAt || localExpiresAt;
      usedStepIndices =
        intentTokenRaw && localPlan
          ? getSessionTokenUsedStepIndices(merged, intentTokenRaw)
          : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.intentRequired && shouldDeny(config)) {
        return denyPreTool(`ArmorCowork intent planning failed: ${message}`);
      }
    }
  }

  // Validate tool against intent token plan
  if (intentTokenRaw) {
    const tokenCheck = checkIntentTokenPlan({
      intentTokenRaw,
      toolName,
      toolParams: toolInput
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
      usedStepIndices
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
        return denyOrAllow(
          config,
          verifyResult.reason || `ArmorCowork intent verification denied for ${toolName}`
        );
      }
      const merged = mergeIntentIntoSession(session, verifyResult);
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
      const deny = denyOrAllow(config, `ArmorCowork verify-step failed: ${message}`);
      if (deny) {
        return deny;
      }
    }
  }

  // --- Expiry check ---
  if (Number.isFinite(localExpiresAt) && nowEpochSeconds() > localExpiresAt) {
    const deny = denyOrAllow(config, "ArmorCowork intent token expired");
    if (deny) {
      return deny;
    }
  }

  // --- Enforce intent requirement ---
  if (config.intentRequired && !remoteAllowed && !tokenCheckMatched) {
    const deny = denyOrAllow(config, "ArmorCowork intent plan missing for this session");
    if (deny) {
      return deny;
    }
  }

  // --- Record tool for discovery ---
  upsertDiscoveredTool(runtimeState, toolName);
  await saveRuntimeState(config.runtimeFile, runtimeState);
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
      } catch { /* fall through to heuristic */ }

      // Fallback: heuristic markdown parsing
      if (!plan) {
        plan = await parsePlanFile(planFilePath);
      }

      if (plan && plan.steps.length > 0) {
        debugLog(config, `captured plan from ExitPlanMode: ${plan.steps.length} steps (${plan.metadata?.source || "heuristic"})`);

        // Send plan to ArmorIQ for intent token
        if (config.intentEndpoint || (config.useSdkIntent && config.apiKey)) {
          const policyState = await loadPolicyState(config.policyFile);
          const intentResponse = await requestIntent(config, {
            prompt: session.lastPrompt || plan.metadata?.goal || "Plan execution",
            plan,
            session_id: sessionId,
            policy_hash: computePolicyHash(policyState.policy),
            policy: policyState.policy,
            validitySeconds: config.validitySeconds,
            metadata: { source: "claude-code", planning: "plan-mode" }
          });
          const merged = mergeIntentIntoSession(session, intentResponse);
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

  try {
    const runtimeState = await loadRuntimeState(config.runtimeFile);
    const session = getSession(runtimeState, sessionId) || {};
    const iapService = createIapService(config);

    const intentTokenRaw = session.intentTokenRaw || "";
    let token = intentTokenRaw;
    // Extract JWT if embedded in JSON envelope
    if (intentTokenRaw.startsWith("{")) {
      try {
        const parsed = JSON.parse(intentTokenRaw);
        token = parsed.jwtToken || parsed.jwt_token || intentTokenRaw;
      } catch { /* use raw */ }
    }

    const dto = {
      token,
      step_index: -1,
      action: toolName,
      tool: toolName,
      input: sanitizeParams(input.tool_input, config.sanitize),
      output: sanitizeParams(input.tool_response, config.sanitize),
      status: "success",
      executed_at: new Date().toISOString(),
      duration_ms: 0
    };

    await iapService.createAuditLog(dto);
    debugLog(config, `audit log sent for ${toolName}`);
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

  try {
    const runtimeState = await loadRuntimeState(config.runtimeFile);
    const session = getSession(runtimeState, sessionId) || {};
    const iapService = createIapService(config);

    const intentTokenRaw = session.intentTokenRaw || "";
    let token = intentTokenRaw;
    if (intentTokenRaw.startsWith("{")) {
      try {
        const parsed = JSON.parse(intentTokenRaw);
        token = parsed.jwtToken || parsed.jwt_token || intentTokenRaw;
      } catch { /* use raw */ }
    }

    const dto = {
      token,
      step_index: -1,
      action: toolName,
      tool: toolName,
      input: sanitizeParams(input.tool_input, config.sanitize),
      output: null,
      status: "failed",
      error_message: typeof input.error === "string" ? input.error : "Unknown error",
      executed_at: new Date().toISOString(),
      duration_ms: 0
    };

    await iapService.createAuditLog(dto);
    debugLog(config, `audit log (failure) sent for ${toolName}`);
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

  upsertSession(runtimeState, sessionId, {
    lastStopAt: nowEpochSeconds()
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
  // Remove the session entirely
  if (runtimeState.sessions && runtimeState.sessions[sessionId]) {
    delete runtimeState.sessions[sessionId];
  }
  await saveRuntimeState(config.runtimeFile, runtimeState);

  debugLog(config, `session ended: ${sessionId}`);
  return null;
}
