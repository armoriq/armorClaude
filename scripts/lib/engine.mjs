import { nowEpochSeconds, sanitizeParams } from "./common.mjs";
import { addPromptContext, blockPrompt, denyPreTool } from "./hook-output.mjs";
import {
  checkIntentTokenPlan,
  extractAllowedActions,
  getSessionTokenUsedStepIndices,
  parseCsrgProofHeaders,
  recordSessionTokenUsedStepIndices,
  requestIntent,
  resolveCsrgProofsFromToken,
  validateCsrgProofHeaders,
  verifyStep
} from "./intent.mjs";
import {
  applyPolicyCommand,
  computePolicyHash,
  evaluatePolicy,
  loadPolicyState,
  parsePolicyTextCommand
} from "./policy.mjs";
import {
  getSession,
  loadRuntimeState,
  saveRuntimeState,
  upsertSession
} from "./runtime-state.mjs";

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

export async function handleUserPromptSubmit(input, config) {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!prompt || !sessionId) {
    return null;
  }

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

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  let session = upsertSession(runtimeState, sessionId, {
    lastPrompt: prompt,
    lastPromptAt: nowEpochSeconds()
  });

  if (config.intentEndpoint || (config.useSdkIntent && config.apiKey)) {
    try {
      const policyState = await loadPolicyState(config.policyFile);
      const intentPayload = {
        prompt,
        session_id: sessionId,
        metadata: { source: "claude-code" },
        policy_hash: computePolicyHash(policyState.policy),
        policy: policyState.policy,
        validitySeconds: config.validitySeconds
      };
      const intentResponse = await requestIntent(config, intentPayload);
      session = mergeIntentIntoSession(session, intentResponse);
      upsertSession(runtimeState, sessionId, session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (shouldDeny(config) && config.intentRequired) {
        return blockPrompt(`ArmorCowork intent planning failed: ${message}`);
      }
      upsertSession(runtimeState, sessionId, { intentError: message });
    }
  }

  await saveRuntimeState(config.runtimeFile, runtimeState);
  if (config.contextHintsEnabled && config.policyUpdateEnabled) {
    return addPromptContext(buildPolicyContextHints());
  }
  return null;
}

function denyOrAllow(config, reason) {
  if (shouldDeny(config)) {
    return denyPreTool(reason);
  }
  return null;
}

export async function handlePreToolUse(input, config) {
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolInput = sanitizeParams(input.tool_input, config.sanitize);
  if (!toolName) {
    return null;
  }

  const policyState = await loadPolicyState(config.policyFile);
  const policyDecision = evaluatePolicy({
    policy: policyState.policy,
    toolName,
    toolParams: toolInput
  });
  if (!policyDecision.allowed) {
    return denyPreTool(policyDecision.reason || "ArmorCowork policy denied");
  }

  const runtimeState = await loadRuntimeState(config.runtimeFile);
  const session = getSession(runtimeState, sessionId) || {};
  let intentTokenRaw = readIntentTokenRaw(input, session);
  let localPlan = session.plan;
  let localExpiresAt = session.expiresAt;
  let remoteAllowed = false;
  let tokenCheckMatched = false;
  let usedStepIndices =
    intentTokenRaw && localPlan ? getSessionTokenUsedStepIndices(session, intentTokenRaw) : undefined;

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
      intentTokenRaw = typeof merged.intentTokenRaw === "string" ? merged.intentTokenRaw : "";
      localPlan = merged.plan || localPlan;
      localExpiresAt = merged.expiresAt || localExpiresAt;
      usedStepIndices =
        intentTokenRaw && localPlan ? getSessionTokenUsedStepIndices(merged, intentTokenRaw) : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (config.intentRequired && shouldDeny(config)) {
        return denyPreTool(`ArmorCowork intent planning failed: ${message}`);
      }
    }
  }

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

  if (intentTokenRaw && config.verifyStepEndpoint && config.csrgVerifyEnabled) {
    try {
      const verifyResult = await verifyStep(config, {
        intentTokenRaw,
        toolName,
        toolParams: toolInput,
        csrgProofs
      });
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

  if (Number.isFinite(localExpiresAt) && nowEpochSeconds() > localExpiresAt) {
    const deny = denyOrAllow(config, "ArmorCowork intent token expired");
    if (deny) {
      return deny;
    }
  }

  if (config.intentRequired && !remoteAllowed && !tokenCheckMatched) {
    const deny = denyOrAllow(config, "ArmorCowork intent plan missing for this session");
    if (deny) {
      return deny;
    }
  }

  await saveRuntimeState(config.runtimeFile, runtimeState);
  return null;
}
