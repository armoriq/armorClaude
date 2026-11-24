import armoriqSdk from "@armoriq/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import {
  isPlainObject,
  isSubsetValue,
  normalizeToolName,
  parseStepIndex,
  readString,
  sha256Hex,
} from "./common.mjs";
import { compilePolicyForSdkIntent } from "./policy-compiler.mjs";
import { writeJson } from "./fs-store.mjs";
import { idempotencyKey, planHash } from "./plan-request.mjs";
import { isBillingError } from "./hook-output.mjs";
import { createAuditWal, loginTag, recordAuthenticationSuccess } from "./audit-wal.mjs";
import { clientEvent } from "./client-events.mjs";
import { createAuditEnvelope } from "./audit-capture.mjs";
import {
  authFingerprint,
  resolveProcessSession,
  promptIsOpen,
  loadRuntimeState,
  sameGenerations,
  retirePlan,
  syncSessionAuth,
  updateRuntimeState,
} from "./runtime-state.mjs";

const { ArmorIQClient } = armoriqSdk;
const sdkClientCache = new Map();
const sdkAttempt = new AsyncLocalStorage();

function buildSdkClientKey(config) {
  return [
    config.apiKey,
    config.userId,
    config.agentId,
    config.contextId,
    config.backendEndpoint,
    config.csrgEndpoint,
    config.runtimeFile,
  ].join("|");
}

export function getSdkClient(config) {
  const key = buildSdkClientKey(config);
  const cached = sdkClientCache.get(key);
  if (cached) {
    return cached;
  }
  const client = new ArmorIQClient({
    apiKey: config.apiKey,
    userId: config.userId,
    agentId: config.agentId,
    contextId: config.contextId,
    iapEndpoint: config.csrgEndpoint,
    backendEndpoint: config.backendEndpoint,
    timeout: config.timeoutMs,
    maxRetries: config.maxRetries,
    verifySsl: config.verifySsl,
    client: config.client,
  });
  // The SDK wraps issuance errors without status or headers, which retry classification needs.
  client.httpClient.interceptors.response.use(
    async (response) => {
      const attempt = sdkAttempt.getStore();
      if (attempt) attempt.response = response;
      if (
        response.status >= 200 &&
        response.status < 300 &&
        response.config?.url &&
        new URL(response.config.url, response.config.baseURL).origin ===
          new URL(config.backendEndpoint).origin
      )
        await recordAuthenticationSuccess(config);
      return response;
    },
    (error) => {
      const attempt = sdkAttempt.getStore();
      if (attempt) attempt.error = error;
      throw error;
    }
  );
  sdkClientCache.set(key, client);
  return client;
}

function resolvePlan(payload) {
  if (isPlainObject(payload.plan)) {
    return payload.plan;
  }
  throw new Error("An explicit intent plan is required");
}

export function extractPlanFromIntentToken(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const rawToken = isPlainObject(parsed.rawToken) ? parsed.rawToken : undefined;
  const planCandidate =
    (rawToken && isPlainObject(rawToken.plan) ? rawToken.plan : undefined) ||
    (isPlainObject(parsed.plan) ? parsed.plan : undefined) ||
    (isPlainObject(parsed.token) && isPlainObject(parsed.token.plan)
      ? parsed.token.plan
      : undefined);
  if (!planCandidate) {
    return null;
  }
  const expiresAt = Number.isFinite(parsed.expiresAt)
    ? parsed.expiresAt
    : isPlainObject(parsed.token) && Number.isFinite(parsed.token.expires_at)
      ? parsed.token.expires_at
      : undefined;
  return { plan: planCandidate, expiresAt, planCheck: parsed.planCheck };
}

export function planCheckDenial(planCheck, toolName) {
  const tool = normalizeToolName(toolName);
  const named = (entry) => normalizeToolName(String(entry).split(":")[0]) === tool;
  if (!(planCheck?.deniedTools ?? []).some(named)) return null;
  const reason = (planCheck.deniedReasons ?? []).find(named);
  return `ArmorIQ plan check denied ${toolName}${reason ? ` (${reason})` : ""}`;
}

export function extractAllowedActions(plan) {
  const allowed = new Set();
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  for (const step of steps) {
    if (!isPlainObject(step)) {
      continue;
    }
    const action =
      typeof step.action === "string"
        ? step.action
        : typeof step.tool === "string"
          ? step.tool
          : "";
    if (action.trim()) {
      allowed.add(normalizeToolName(action));
    }
  }
  return allowed;
}

function getStepInputCandidates(step) {
  const candidates = [];
  if (isPlainObject(step.params)) {
    candidates.push(step.params);
  }
  if (isPlainObject(step.arguments)) {
    candidates.push(step.arguments);
  }
  return candidates;
}

export function findPlanStepIndices(plan, toolName, toolParams) {
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const normalizedTool = normalizeToolName(toolName);
  const matches = [];
  const paramMatches = [];
  for (let idx = 0; idx < steps.length; idx += 1) {
    const step = steps[idx];
    if (!isPlainObject(step)) {
      continue;
    }
    const action =
      typeof step.action === "string"
        ? step.action
        : typeof step.tool === "string"
          ? step.tool
          : "";
    if (normalizeToolName(action) !== normalizedTool) {
      continue;
    }
    matches.push(idx);
    if (toolParams) {
      const inputCandidates = getStepInputCandidates(step);
      if (inputCandidates.some((inputs) => isSubsetValue(inputs, toolParams))) {
        paramMatches.push(idx);
      }
    }
  }
  return { matches, paramMatches };
}

export function checkToolAgainstPlan({ plan, toolName, toolInput, strict = false }) {
  const normalizedTool = normalizeToolName(toolName);
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) {
    return { allowed: false, reason: "ArmorClaude intent plan is empty" };
  }
  const matches = [];
  for (const step of steps) {
    if (!isPlainObject(step)) {
      continue;
    }
    const action =
      typeof step.action === "string"
        ? step.action
        : typeof step.tool === "string"
          ? step.tool
          : "";
    if (normalizeToolName(action) === normalizedTool) {
      matches.push(step);
    }
  }
  if (!matches.length) {
    return { allowed: false, reason: `ArmorClaude intent drift: tool not in plan (${toolName})` };
  }
  if (!isPlainObject(toolInput)) {
    return { allowed: true };
  }
  let sawConstrainedMatch = false;
  for (const step of matches) {
    const inputCandidates = getStepInputCandidates(step);
    if (inputCandidates.length === 0) {
      return { allowed: true };
    }
    sawConstrainedMatch = true;
    if (inputCandidates.some((candidate) => isSubsetValue(candidate, toolInput))) {
      return { allowed: true };
    }
  }
  // Param checks are permissive by default; ARMORCLAUDE_STRICT_PARAM_CHECK=true turns on strict checking.
  if (sawConstrainedMatch && strict) {
    return {
      allowed: false,
      reason: `ArmorClaude intent mismatch: parameters not allowed for ${toolName}`,
    };
  }
  return { allowed: true };
}

export function checkIntentTokenPlan({ intentTokenRaw, toolName, toolParams }) {
  const parsed = extractPlanFromIntentToken(intentTokenRaw);
  if (!parsed) {
    return { matched: false };
  }
  if (parsed.expiresAt && Date.now() / 1000 >= parsed.expiresAt) {
    return {
      matched: true,
      blockReason:
        "ArmorIQ intent token expired — call register_intent_plan to refresh, then retry",
      plan: parsed.plan,
    };
  }
  const denial = planCheckDenial(parsed.planCheck, toolName);
  if (denial) {
    return { matched: true, blockReason: denial, planCheckDenied: true, plan: parsed.plan };
  }
  const allowedActions = extractAllowedActions(parsed.plan);
  if (!allowedActions.has(normalizeToolName(toolName))) {
    return {
      matched: true,
      blockReason: `ArmorIQ intent drift: tool not in plan (${toolName})`,
      plan: parsed.plan,
    };
  }

  if (isPlainObject(toolParams)) {
    const paramCheck = checkToolAgainstPlan({
      plan: parsed.plan,
      toolName,
      toolInput: toolParams,
    });
    if (!paramCheck.allowed) {
      return {
        matched: true,
        blockReason: paramCheck.reason,
        plan: parsed.plan,
      };
    }
  }

  return {
    matched: true,
    params: isPlainObject(toolParams) ? toolParams : undefined,
    plan: parsed.plan,
  };
}

export function parseStepIndexFromPath(path) {
  if (!path) {
    return null;
  }
  const match = path.match(/\/steps\/\[(\d+)\]/);
  if (!match) {
    return null;
  }
  const index = Number.parseInt(match[1] || "", 10);
  return Number.isFinite(index) ? index : null;
}

function readStepProofsFromToken(tokenObj) {
  if (Array.isArray(tokenObj.stepProofs)) {
    return tokenObj.stepProofs;
  }
  if (Array.isArray(tokenObj.step_proofs)) {
    return tokenObj.step_proofs;
  }
  if (isPlainObject(tokenObj.rawToken)) {
    if (Array.isArray(tokenObj.rawToken.stepProofs)) {
      return tokenObj.rawToken.stepProofs;
    }
    if (Array.isArray(tokenObj.rawToken.step_proofs)) {
      return tokenObj.rawToken.step_proofs;
    }
  }
  return null;
}

function resolveStepProofEntry(stepProofs, stepIndex) {
  const entry = stepProofs[stepIndex];
  if (!entry) {
    return null;
  }
  if (Array.isArray(entry)) {
    return { proof: entry, stepIndex };
  }
  if (!isPlainObject(entry)) {
    return null;
  }
  const proof = Array.isArray(entry.proof) ? entry.proof : undefined;
  const path =
    readString(entry.path) ||
    readString(entry.step_path) ||
    readString(entry.csrg_path) ||
    undefined;
  const indexFromField = parseStepIndex(entry.step_index) ?? parseStepIndex(entry.stepIndex);
  const indexFromPath = parseStepIndexFromPath(path);
  const resolvedStepIndex = indexFromField ?? indexFromPath ?? stepIndex;
  const valueDigest =
    readString(entry.value_digest) ||
    readString(entry.valueDigest) ||
    readString(entry.csrg_value_digest) ||
    undefined;
  return { proof, path, valueDigest, stepIndex: resolvedStepIndex };
}

function scoreProofPath(path) {
  if (!path) {
    return 0;
  }
  if (/\/(action|tool)$/i.test(path)) {
    return 3;
  }
  if (/\/(arguments|params|metadata)$/i.test(path)) {
    return 1;
  }
  return 2;
}

function chooseProofEntry(entries, usedStepIndices) {
  if (!entries.length) {
    return null;
  }
  const stepGroups = new Map();
  for (const entry of entries) {
    const list = stepGroups.get(entry.stepIndex) || [];
    list.push(entry);
    stepGroups.set(entry.stepIndex, list);
  }
  const orderedStepIndices = Array.from(stepGroups.keys()).sort((a, b) => {
    const aUsed = usedStepIndices?.has(a) ? 1 : 0;
    const bUsed = usedStepIndices?.has(b) ? 1 : 0;
    if (aUsed !== bUsed) {
      return aUsed - bUsed;
    }
    return a - b;
  });
  const selectedStepIndex = orderedStepIndices[0];
  if (selectedStepIndex === undefined) {
    return null;
  }
  const candidates = stepGroups.get(selectedStepIndex) || [];
  candidates.sort((a, b) => {
    const pathScore = scoreProofPath(b.path) - scoreProofPath(a.path);
    if (pathScore !== 0) {
      return pathScore;
    }
    const digestScore = Number(Boolean(b.valueDigest)) - Number(Boolean(a.valueDigest));
    if (digestScore !== 0) {
      return digestScore;
    }
    return 0;
  });
  return candidates[0] || null;
}

export function resolveCsrgProofsFromToken({
  intentTokenRaw,
  plan,
  toolName,
  toolParams,
  usedStepIndices,
}) {
  let parsed;
  try {
    parsed = JSON.parse(intentTokenRaw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }
  const stepProofs = readStepProofsFromToken(parsed);
  if (!stepProofs || stepProofs.length === 0) {
    return null;
  }
  const normalizedParams = isPlainObject(toolParams) ? toolParams : undefined;
  const { matches, paramMatches } = findPlanStepIndices(plan, toolName, normalizedParams);
  if (matches.length === 0) {
    return null;
  }
  const resolvedEntries = [];
  for (let idx = 0; idx < stepProofs.length; idx += 1) {
    const entry = resolveStepProofEntry(stepProofs, idx);
    if (!entry?.proof || !Array.isArray(entry.proof)) {
      continue;
    }
    resolvedEntries.push(entry);
  }
  const entriesMatchingTool = resolvedEntries.filter((entry) => matches.includes(entry.stepIndex));
  if (!entriesMatchingTool.length) {
    return null;
  }
  const entriesMatchingParams =
    paramMatches.length > 0
      ? entriesMatchingTool.filter((entry) => paramMatches.includes(entry.stepIndex))
      : [];
  const selected = chooseProofEntry(
    entriesMatchingParams.length > 0 ? entriesMatchingParams : entriesMatchingTool,
    usedStepIndices
  );
  if (!selected || !Array.isArray(selected.proof)) {
    return null;
  }
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const stepIndex = selected.stepIndex;
  const stepObj = steps[stepIndex];
  const action =
    isPlainObject(stepObj) && typeof stepObj.action === "string"
      ? stepObj.action
      : isPlainObject(stepObj) && typeof stepObj.tool === "string"
        ? stepObj.tool
        : toolName;
  return {
    path: selected.path || `/steps/[${stepIndex}]/action`,
    proof: selected.proof,
    valueDigest: selected.valueDigest || sha256Hex(JSON.stringify(action)),
    stepIndex,
  };
}

function parseProofValue(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return { error: "ArmorIQ CSRG proof header must be a JSON array" };
    } catch {
      return { error: "ArmorIQ CSRG proof header invalid JSON" };
    }
  }
  return undefined;
}

function readFromHeaderMap(headers, keys) {
  if (!isPlainObject(headers)) {
    return undefined;
  }
  for (const key of keys) {
    const value = readString(headers[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function parseCsrgProofHeaders(input) {
  const headers = isPlainObject(input.headers) ? input.headers : undefined;
  const path =
    readString(input.csrgPath) ||
    readString(input.csrg_path) ||
    readString(input["x-csrg-path"]) ||
    readFromHeaderMap(headers, ["x-csrg-path", "X-CSRG-Path"]) ||
    undefined;
  const valueDigest =
    readString(input.csrgValueDigest) ||
    readString(input.csrg_value_digest) ||
    readString(input["x-csrg-value-digest"]) ||
    readFromHeaderMap(headers, ["x-csrg-value-digest", "X-CSRG-Value-Digest"]) ||
    undefined;
  const proofRaw =
    input.csrgProofRaw ??
    input.csrg_proof ??
    input["x-csrg-proof"] ??
    (headers ? (headers["x-csrg-proof"] ?? headers["X-CSRG-Proof"]) : undefined);

  if (!path && !valueDigest && proofRaw === undefined) {
    return {};
  }
  const parsedProof = parseProofValue(proofRaw);
  if (isPlainObject(parsedProof) && parsedProof.error) {
    return { error: parsedProof.error };
  }
  return {
    proofs: {
      path,
      valueDigest,
      proof: parsedProof,
    },
  };
}

export function validateCsrgProofHeaders(proofs, required) {
  if (!required) {
    return null;
  }
  if (!proofs) {
    return "ArmorIQ CSRG proof headers missing";
  }
  if (!proofs.path) {
    return "ArmorIQ CSRG path header missing";
  }
  if (!proofs.valueDigest) {
    return "ArmorIQ CSRG value digest header missing";
  }
  if (!proofs.proof || !Array.isArray(proofs.proof)) {
    return "ArmorIQ CSRG proof header missing";
  }
  return null;
}

export async function requestIntent(config, payload) {
  if (!config.apiKey || config.signedOut || config.mode === "monitor") {
    return { skipped: true };
  }
  if (config.runtimeFile && payload.session_id) {
    const state = await loadRuntimeState(config.runtimeFile);
    if (
      state.sessions[payload.session_id]?.pendingRequest?.headers?.["X-ArmorIQ-Plan-Kind"] ===
      "refresh"
    ) {
      await refreshIntent(config, payload.session_id, { reloadConfig: payload.reloadConfig });
      const current = await loadRuntimeState(config.runtimeFile);
      if (
        current.sessions[payload.session_id]?.pendingRequest?.headers?.["X-ArmorIQ-Plan-Kind"] ===
        "refresh"
      )
        throw registrationError(
          "a token refresh is still pending; retry registration after it completes",
          true
        );
    }
    const descriptor = await preparePlanRequest(config, payload);
    if (descriptor) return sendPlanRequest(config, descriptor, payload.reloadConfig);
  }
  throw registrationError("root prompt identity unavailable");
}

const REGISTRATION_DEADLINE_MS = 40_000;
const INTENT_POLICY_COMPILER_VERSION = "sdk-csrg-policy-v1";
let warnedLegacyBackend = false;

function registrationError(reason, unconfirmed = false) {
  return Object.assign(new Error(reason), { unconfirmed });
}

function planRequestBody(config, payload, plan) {
  return {
    user_id: config.userId || "__sdk_multiuser__",
    agent_id: config.agentId || "__sdk_multiuser__",
    context_id: payload.session_id,
    plan,
    ...(payload.policy
      ? { policy: compilePolicyForSdkIntent(payload.policy, payload.policy_hash) }
      : {}),
    expires_in: payload.validitySeconds ?? config.validitySeconds,
  };
}

async function preparePlanRequest(config, payload) {
  const descriptor = await updateRuntimeState(config.runtimeFile, (state) => {
    syncSessionAuth(state, config, payload.session_id);
    const session = state.sessions[payload.session_id];
    if (!session?.promptId) return null;
    if (payload.generations && !sameGenerations(session, payload.generations))
      throw registrationError("plan retired before registration completed");
    const plan = resolvePlan({ ...payload, mcpName: config.mcpName });
    const hash = planHash(plan);
    if (session.pendingRequest) {
      if (session.pendingRequest.planHash !== hash)
        throw registrationError(
          "a different plan registration is still pending; resend the identical pending plan to retry it",
          true
        );
      if (session.pendingRequest.unconfirmed) {
        session.pendingRequest.deadlineAt = Date.now() + REGISTRATION_DEADLINE_MS;
        delete session.pendingRequest.unconfirmed;
      }
      return session.pendingRequest;
    }
    const kind = session.countedPlanId ? "revision" : "new";
    const key = idempotencyKey({
      kind,
      promptId: session.promptId,
      parentPlanId: session.countedPlanId,
      planHash: hash,
      epoch: session.retirementEpoch,
    });
    const headers = {
      "Idempotency-Key": key,
      "X-ArmorIQ-Plan-Kind": kind,
      "X-ArmorIQ-Prompt-Id": session.promptId,
      ...(session.countedPlanId ? { "X-ArmorIQ-Parent-Plan-Id": session.countedPlanId } : {}),
    };
    const body = planRequestBody(config, payload, plan);
    session.pendingRequest = {
      key,
      headers,
      body,
      planHash: hash,
      policyHash: payload.policy_hash || "",
      promptId: session.promptId,
      promptGeneration: session.promptGeneration,
      authGeneration: session.authGeneration,
      deadlineAt: Date.now() + REGISTRATION_DEADLINE_MS,
    };
    return session.pendingRequest;
  });
  return descriptor;
}

function requestIsCurrent(session, descriptor) {
  return (
    sameGenerations(session, descriptor) &&
    session?.promptId === descriptor.promptId &&
    session?.pendingRequest?.key === descriptor.key &&
    (descriptor.headers["X-ArmorIQ-Plan-Kind"] !== "refresh" ||
      (promptIsOpen(session) &&
        session.countedPlanId === descriptor.headers["X-ArmorIQ-Parent-Plan-Id"]))
  );
}

function requestReason(config, response, error) {
  const reason =
    response?.data?.message ||
    response?.data?.error ||
    error?.message ||
    "invalid backend response";
  const masked = config.apiKey
    ? String(reason).split(config.apiKey).join("[redacted]")
    : String(reason);
  return masked.replace(/\s+/g, " ").trim().replace(/\.+$/, "");
}

function retryDelay(response, attempt) {
  const header = response?.headers?.["retry-after"];
  if (header !== undefined && String(header).trim() !== "") {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(1000 * 2 ** attempt, 4000);
}

async function recordPlanRequestFailure(config, descriptor, reason, unconfirmed = false) {
  descriptor.lastReasonCode = reason;
  await updateRuntimeState(config.runtimeFile, (state) => {
    const session = state.sessions[descriptor.body.context_id];
    if (requestIsCurrent(session, descriptor)) {
      if (unconfirmed) session.pendingRequest.unconfirmed = true;
      else session.pendingRequest = null;
    }
  });
  const tag = loginTag(config.backendEndpoint, config.apiKey);
  const event = clientEvent("plan_request_failed", "health", 1, reason, Date.now(), {
    event_id: createAuditEnvelope({
      root_session_id: "plan_request_failed",
      tool_use_id: descriptor.key,
    }).decisionId,
  });
  try {
    await createAuditWal({
      dataDir: config.dataDir,
      login: tag,
      binding: { backend: config.backendEndpoint, keyId: tag },
      stream: "health",
    }).appendLine(event);
  } catch {
    process.stderr.write("[armorclaude] plan request health event could not be stored.\n");
  }
}

async function sendPlanRequest(config, descriptor, reloadConfig = () => config) {
  return sendPreparedPlanRequest(config, descriptor, reloadConfig);
}

async function sendPreparedPlanRequest(config, descriptor, reloadConfig) {
  const { body, headers } = descriptor;
  const client = Object.assign(Object.create(getSdkClient(config)), {
    userId: body.user_id,
    agentId: body.agent_id,
    contextId: body.context_id,
    maxRetries: 0,
  });
  const capture = client.capturePlan(config.llmId, "", body.plan);
  let reason = descriptor.lastReason || "request deadline exceeded";
  let reasonCode = descriptor.lastReasonCode || "timeout";
  for (let attempt = 0; ; attempt += 1) {
    const current = await updateRuntimeState(config.runtimeFile, (state) => {
      syncSessionAuth(state, reloadConfig(), body.context_id);
      return requestIsCurrent(state.sessions[body.context_id], descriptor);
    });
    if (!current) throw registrationError("plan retired before registration completed");
    const remaining = descriptor.deadlineAt - Date.now();
    if (remaining <= 0) break;
    if (descriptor.retryAt > Date.now()) {
      if (descriptor.retryAt >= descriptor.deadlineAt) break;
      await new Promise((resolve) => setTimeout(resolve, descriptor.retryAt - Date.now()));
      continue;
    }
    const httpResult = {};
    try {
      const token = await sdkAttempt.run(httpResult, () =>
        client.getIntentToken(capture, body.policy, body.expires_in, {
          contextId: body.context_id,
          idempotencyKey: descriptor.key,
          planKind: headers["X-ArmorIQ-Plan-Kind"],
          parentPlanId: headers["X-ArmorIQ-Parent-Plan-Id"],
          promptId: headers["X-ArmorIQ-Prompt-Id"],
          timeoutMs: Math.min(config.timeoutMs || 8000, remaining),
        })
      );
      if (!token.planId || !Number.isFinite(token.expiresAt)) {
        reason = "invalid backend response";
        reasonCode = "rejected";
        break;
      }
      if (!token.kind && !warnedLegacyBackend) {
        warnedLegacyBackend = true;
        process.stderr.write(
          "[armorclaude] backend response has no kind; using the requested plan kind.\n"
        );
      }
      const result = {
        skipped: false,
        source: "armoriq-sdk",
        tokenRaw: JSON.stringify(token),
        plan: body.plan,
        expiresAt: token.expiresAt,
        countedPlanId:
          headers["X-ArmorIQ-Plan-Kind"] === "refresh"
            ? headers["X-ArmorIQ-Parent-Plan-Id"]
            : token.planId,
        kind: token.kind || headers["X-ArmorIQ-Plan-Kind"],
      };
      const installed = await updateRuntimeState(config.runtimeFile, (state) => {
        syncSessionAuth(state, reloadConfig(), body.context_id);
        const session = state.sessions[body.context_id];
        if (!requestIsCurrent(session, descriptor))
          return (
            sameGenerations(session, descriptor) &&
            session?.promptId === descriptor.promptId &&
            session?.tokenPlanId === token.planId &&
            (headers["X-ArmorIQ-Plan-Kind"] !== "refresh" || promptIsOpen(session))
          );
        Object.assign(session, {
          plan: body.plan,
          planHash: descriptor.planHash,
          countedPlanId: result.countedPlanId,
          tokenPlanId: token.planId,
          kind: headers["X-ArmorIQ-Plan-Kind"] === "refresh" ? session.kind : result.kind,
          tokenExpiresAt: new Date(token.expiresAt * 1000).toISOString(),
          expiresAt: token.expiresAt,
          intentTokenRaw: result.tokenRaw,
          allowedActions: Array.from(extractAllowedActions(body.plan)),
          policyHash: descriptor.policyHash,
          intentPolicyCompilerVersion: INTENT_POLICY_COMPILER_VERSION,
          pendingRequest: null,
          unregisteredLocalPlan: null,
          intentRequestFailed: false,
          apiKeyPrefix: config.apiKey.slice(0, 16),
          planRequestBody: body,
          tokenValiditySeconds: body.expires_in,
          refreshFailures: 0,
          refreshRetryAt: 0,
        });
        return true;
      });
      if (!installed) throw registrationError("plan retired before registration completed");
      return result;
    } catch (error) {
      if (error?.message === "plan retired before registration completed") throw error;
      const { response, error: networkError } = httpResult;
      reason = requestReason(config, response, networkError || error);
      const status = response?.status;
      if (status === 402 && isBillingError(`402 ${reason}`)) {
        const installed = await updateRuntimeState(config.runtimeFile, (state) => {
          syncSessionAuth(state, reloadConfig(), body.context_id);
          const session = state.sessions[body.context_id];
          if (!requestIsCurrent(session, descriptor)) return false;
          retirePlan(session);
          Object.assign(session, {
            plan: body.plan,
            planHash: descriptor.planHash,
            policyHash: descriptor.policyHash,
            intentPolicyCompilerVersion: INTENT_POLICY_COMPILER_VERSION,
            unregisteredLocalPlan: {
              plan: body.plan,
              reason: "billing",
              message: reason,
              recordedAt: Date.now(),
            },
          });
          return true;
        });
        if (!installed) throw registrationError("plan retired before registration completed");
        return { skipped: true, billing: true, plan: body.plan };
      }
      reasonCode =
        status === 429
          ? "rate_limited"
          : status >= 500
            ? "server_error"
            : status === 409 && response?.data?.error === "request_in_progress"
              ? "request_in_progress"
              : !response && networkError
                ? /TIMEOUT|ETIMEDOUT|ECONNABORTED/.test(networkError.code ?? "")
                  ? "timeout"
                  : "network"
                : "rejected";
      if (status < 400 && response?.data?.success) {
        await recordPlanRequestFailure(config, descriptor, reasonCode, true);
        throw registrationError(requestReason(config, undefined, error), true);
      }
      const retryable =
        status === 429 ||
        (status >= 500 && status <= 599) ||
        (status === 409 && response?.data?.error === "request_in_progress") ||
        (!response &&
          [
            "ECONNREFUSED",
            "ECONNRESET",
            "ETIMEDOUT",
            "ECONNABORTED",
            "EPIPE",
            "ENOTFOUND",
            "EAI_AGAIN",
            "ERR_NETWORK",
          ].includes(networkError?.code));
      if (!retryable) {
        await recordPlanRequestFailure(config, descriptor, reasonCode);
        throw registrationError(reason);
      }
      const delay = retryDelay(response, attempt);
      descriptor.retryAt = Date.now() + delay;
      descriptor.lastReason = reason;
      descriptor.lastReasonCode = reasonCode;
      await updateRuntimeState(config.runtimeFile, (state) => {
        const session = state.sessions[body.context_id];
        if (requestIsCurrent(session, descriptor)) {
          session.pendingRequest.retryAt = descriptor.retryAt;
          session.pendingRequest.lastReason = reason;
          session.pendingRequest.lastReasonCode = reasonCode;
        }
      });
      if (descriptor.retryAt >= descriptor.deadlineAt) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  await recordPlanRequestFailure(config, descriptor, reasonCode, true);
  throw registrationError(reason, true);
}

const refreshFlights = new Map();

export function refreshIntent(
  config,
  sessionId,
  { expiredOnly = false, reloadConfig = () => config } = {}
) {
  const flightKey = `${config.runtimeFile}:${sessionId}`;
  if (refreshFlights.has(flightKey)) return refreshFlights.get(flightKey);
  const flight = refreshCurrentIntent(config, sessionId, expiredOnly, reloadConfig).finally(() => {
    if (refreshFlights.get(flightKey) === flight) refreshFlights.delete(flightKey);
  });
  refreshFlights.set(flightKey, flight);
  return flight;
}

async function refreshCurrentIntent(config, sessionId, expiredOnly, reloadConfig) {
  const descriptor = await updateRuntimeState(config.runtimeFile, async (state) => {
    const session = state.sessions[sessionId];
    if (session?.authFingerprint !== authFingerprint(reloadConfig())) return null;
    if (
      !config.apiKey ||
      config.signedOut ||
      config.mode === "monitor" ||
      !promptIsOpen(session) ||
      !session.countedPlanId ||
      !session.intentTokenRaw ||
      !isPlainObject(session.plan)
    )
      return null;
    const expiresAt = Date.parse(session.tokenExpiresAt);
    if (!Number.isFinite(expiresAt)) return null;
    const validity = session.tokenValiditySeconds ?? config.validitySeconds;
    const threshold = expiredOnly ? 0 : Math.min(120, validity / 3) * 1000;
    if (expiresAt - Date.now() > threshold || session.refreshRetryAt > Date.now()) return null;
    if (session.pendingRequest) {
      if (
        session.pendingRequest.headers?.["X-ArmorIQ-Plan-Kind"] !== "refresh" ||
        session.pendingRequest.retryAt > Date.now()
      )
        return null;
      if (session.pendingRequest.unconfirmed) {
        session.pendingRequest.deadlineAt = Date.now() + REGISTRATION_DEADLINE_MS;
        delete session.pendingRequest.unconfirmed;
      }
      return session.pendingRequest;
    }
    const key = idempotencyKey({
      kind: "refresh",
      countedPlanId: session.countedPlanId,
      tokenExpiresAt: session.tokenExpiresAt,
    });
    let body = session.planRequestBody;
    if (!body) {
      const { loadPolicyState } = await import("./policy.mjs");
      const { policy } = await loadPolicyState(config.policyFile);
      body = planRequestBody(
        config,
        {
          session_id: sessionId,
          policy,
          policy_hash: session.policyHash,
          validitySeconds: validity,
        },
        session.plan
      );
    }
    session.pendingRequest = {
      key,
      headers: {
        "Idempotency-Key": key,
        "X-ArmorIQ-Plan-Kind": "refresh",
        "X-ArmorIQ-Parent-Plan-Id": session.countedPlanId,
        "X-ArmorIQ-Prompt-Id": session.promptId,
      },
      body,
      planHash: session.planHash,
      policyHash: session.policyHash,
      promptId: session.promptId,
      promptGeneration: session.promptGeneration,
      authGeneration: session.authGeneration,
      deadlineAt: Date.now() + REGISTRATION_DEADLINE_MS,
    };
    return session.pendingRequest;
  });
  if (!descriptor) return { skipped: true };
  try {
    return await sendPlanRequest(config, descriptor, reloadConfig);
  } catch (error) {
    await updateRuntimeState(config.runtimeFile, (state) => {
      const session = state.sessions[sessionId];
      if (
        !sameGenerations(session, descriptor) ||
        session?.countedPlanId !== descriptor.headers["X-ArmorIQ-Parent-Plan-Id"]
      )
        return;
      if (!promptIsOpen(session)) {
        if (session.pendingRequest?.key === descriptor.key) session.pendingRequest = null;
        return;
      }
      session.refreshFailures = (session.refreshFailures || 0) + 1;
      session.refreshRetryAt = Math.max(
        descriptor.retryAt || 0,
        Date.now() + Math.min(15_000 * 2 ** (session.refreshFailures - 1), 120_000)
      );
    });
    if (config.debug)
      process.stderr.write(
        `[armorclaude] refresh failed: ${requestReason(config, undefined, error)}\n`
      );
    return { skipped: true };
  }
}

export function startIntentRefreshLoop(reloadConfig) {
  const timer = setInterval(async () => {
    try {
      const config = reloadConfig();
      const state = await loadRuntimeState(config.runtimeFile);
      await Promise.all(
        Object.keys(state.sessions)
          .filter((id) => state.sessions[id].authFingerprint === authFingerprint(config))
          .map((sessionId) => refreshIntent(config, sessionId, { reloadConfig }))
      );
    } catch (error) {
      process.stderr.write(`[armorclaude] refresh loop failed: ${error?.message || error}\n`);
    }
  }, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}

function registrationReply(message, isError = false) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { message },
    ...(isError ? { isError: true } : {}),
  };
}

function registeredReply(session, plan) {
  return registrationReply(
    `Intent registered: plan ${session.countedPlanId} (${session.kind}), ${plan.steps.length} steps. Token valid until ${session.tokenExpiresAt}.`
  );
}

export async function registerIntentPlan(
  config,
  plan,
  { reloadConfig = () => config, forceRevision = false } = {}
) {
  let confirmed = false;
  try {
    const prepared = await updateRuntimeState(config.runtimeFile, async (state) => {
      const sessionId = resolveProcessSession(state);
      if (!sessionId) throw registrationError("session identity unavailable");
      syncSessionAuth(state, config, sessionId);
      const session = state.sessions[sessionId];
      const reason =
        !config.apiKey || config.signedOut
          ? "logged_out"
          : config.mode === "monitor"
            ? "monitor_mode"
            : null;
      if (reason) {
        session.unregisteredLocalPlan = { plan, reason, recordedAt: Date.now() };
        await writePendingPlan(config, sessionId, session, { plan });
        return { reply: registrationReply(`Plan recorded locally, not registered (${reason}).`) };
      }
      if (forceRevision && !session.countedPlanId)
        throw registrationError("no current plan in this prompt to reanchor");
      if (
        !forceRevision &&
        session.countedPlanId &&
        session.planHash === planHash(plan) &&
        session.intentTokenRaw &&
        Date.parse(session.tokenExpiresAt) > Date.now()
      )
        return { reply: registeredReply(session, plan) };
      return {
        sessionId,
        generations: {
          promptGeneration: session.promptGeneration,
          authGeneration: session.authGeneration,
        },
      };
    });
    if (prepared.reply) return prepared.reply;
    const { loadPolicyState, computePolicyHash } = await import("./policy.mjs");
    const policyState = await loadPolicyState(config.policyFile);
    const result = await requestIntent(config, {
      plan,
      session_id: prepared.sessionId,
      generations: prepared.generations,
      policy: policyState.policy,
      policy_hash: computePolicyHash(policyState.policy),
      validitySeconds: config.validitySeconds,
      reloadConfig,
    });
    if (result.billing)
      return registrationReply(
        `Plan recorded locally, not registered (billing). Your policy is still enforced locally. Upgrade: ${billingUpgradeUrl(config)}`
      );
    confirmed = true;
    return await updateRuntimeState(config.runtimeFile, async (state) => {
      syncSessionAuth(state, reloadConfig(), prepared.sessionId);
      const session = state.sessions[prepared.sessionId];
      if (
        !sameGenerations(session, prepared.generations) ||
        session?.countedPlanId !== result.countedPlanId ||
        session?.tokenPlanId !== JSON.parse(result.tokenRaw).planId
      )
        throw registrationError("plan retired before registration completed");
      await writePendingPlan(config, prepared.sessionId, session, result);
      return registeredReply(session, plan);
    });
  } catch (error) {
    const reason = requestReason(config, undefined, error);
    return registrationReply(
      error.unconfirmed ||
        (confirmed && error.message !== "plan retired before registration completed")
        ? `Plan registration not confirmed: ${reason}. It will be retried with the same request id.`
        : `Plan not registered: ${reason}.`,
      true
    );
  }
}

export function billingUpgradeUrl(config) {
  return (
    config.upgradeUrl ||
    process.env.ARMORCLAUDE_UPGRADE_URL ||
    "https://tools.armoriq.ai/tools/billing"
  );
}

async function writePendingPlan(config, sessionId, session, result) {
  await writeJson(path.join(config.dataDir, `pending-plan.${sessionId}.json`), {
    sessionId,
    promptId: session.promptId,
    promptGeneration: session.promptGeneration,
    authGeneration: session.authGeneration,
    plan: result.plan,
    tokenRaw: result.tokenRaw || "",
    allowedActions: Array.from(extractAllowedActions(result.plan)),
    expiresAt: result.expiresAt,
    policyHash: session.policyHash || "",
    intentPolicyCompilerVersion: INTENT_POLICY_COMPILER_VERSION,
    registeredAt: Date.now(),
  });
}

export function getSessionTokenUsedStepIndices(session, intentTokenRaw) {
  if (!session || typeof intentTokenRaw !== "string" || !intentTokenRaw.trim()) {
    return undefined;
  }
  const tokenHash = sha256Hex(intentTokenRaw);
  const tracker = isPlainObject(session.intentExecution) ? session.intentExecution : {};
  if (tracker.tokenHash !== tokenHash) {
    tracker.tokenHash = tokenHash;
    tracker.usedStepIndices = [];
    session.intentExecution = tracker;
  }
  const used = Array.isArray(tracker.usedStepIndices) ? tracker.usedStepIndices : [];
  tracker.usedStepIndices = used.filter((value) => Number.isFinite(value));
  session.intentExecution = tracker;
  return new Set(tracker.usedStepIndices);
}

export function recordSessionTokenUsedStepIndices(session, intentTokenRaw, usedStepIndices) {
  if (!session || typeof intentTokenRaw !== "string" || !intentTokenRaw.trim()) {
    return;
  }
  const tokenHash = sha256Hex(intentTokenRaw);
  session.intentExecution = {
    tokenHash,
    usedStepIndices: Array.from(usedStepIndices || []).filter((value) => Number.isFinite(value)),
  };
}
