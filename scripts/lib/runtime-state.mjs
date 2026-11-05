import { nowEpochSeconds } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";

const MAX_SESSION_AGE_SECONDS = 60 * 60 * 24;

export async function loadRuntimeState(runtimeFilePath) {
  const initial = { sessions: {}, mcpRegistry: {} };
  const raw = await readJson(runtimeFilePath, initial);
  const sessions =
    raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object"
      ? raw.sessions
      : {};
  const mcpRegistry =
    raw && typeof raw === "object" && raw.mcpRegistry && typeof raw.mcpRegistry === "object"
      ? raw.mcpRegistry
      : {};
  const discoveredTools = Array.isArray(raw?.discoveredTools) ? raw.discoveredTools : [];
  const state = { sessions, mcpRegistry, discoveredTools };
  if (typeof raw?.activeSessionId === "string") state.activeSessionId = raw.activeSessionId;
  if (Number.isFinite(raw?.activeSessionAt)) state.activeSessionAt = raw.activeSessionAt;
  return state;
}

export function setActiveSessionId(runtimeState, sessionId) {
  if (!sessionId || typeof sessionId !== "string") return;
  runtimeState.activeSessionId = sessionId;
  runtimeState.activeSessionAt = nowEpochSeconds();
}

export function getActiveSessionId(runtimeState) {
  return typeof runtimeState?.activeSessionId === "string" ? runtimeState.activeSessionId : "";
}

export function getSession(runtimeState, sessionId) {
  if (!sessionId) {
    return undefined;
  }
  return runtimeState.sessions[sessionId];
}

export function upsertSession(runtimeState, sessionId, patch) {
  const prev = getSession(runtimeState, sessionId) || {};
  runtimeState.sessions[sessionId] = {
    ...prev,
    ...patch,
    updatedAt: nowEpochSeconds(),
  };
  return runtimeState.sessions[sessionId];
}

const POST_EXPIRY_GRACE_SECONDS = 60 * 60;

export function pruneSessions(runtimeState) {
  const now = nowEpochSeconds();
  for (const [sessionId, session] of Object.entries(runtimeState.sessions)) {
    const updatedAt = Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
    if (now - updatedAt > MAX_SESSION_AGE_SECONDS) {
      delete runtimeState.sessions[sessionId];
      continue;
    }
    const expiresAt = Number.isFinite(session.expiresAt) ? session.expiresAt : 0;
    if (expiresAt > 0 && now - expiresAt > POST_EXPIRY_GRACE_SECONDS) {
      delete runtimeState.sessions[sessionId];
    }
  }
}

export async function saveRuntimeState(runtimeFilePath, runtimeState) {
  pruneSessions(runtimeState);
  await writeJson(runtimeFilePath, runtimeState);
}

export function upsertDiscoveredTool(runtimeState, toolName) {
  if (!toolName || typeof toolName !== "string") return;
  const name = toolName.trim();
  if (!name) return;
  if (!Array.isArray(runtimeState.discoveredTools)) {
    runtimeState.discoveredTools = [];
  }
  const normalized = name.toLowerCase();
  const existing = runtimeState.discoveredTools.map((t) => t.toLowerCase());
  if (!existing.includes(normalized)) {
    runtimeState.discoveredTools.push(name);
  }
}

export function getDiscoveredTools(runtimeState) {
  return Array.isArray(runtimeState?.discoveredTools) ? runtimeState.discoveredTools : [];
}

export function appendTrustOp(runtimeState, sessionId, op) {
  if (!sessionId || !op || typeof op !== "object") return;
  const session = getSession(runtimeState, sessionId);
  if (!session) return;
  if (!Array.isArray(session.trustOpsLog)) {
    session.trustOpsLog = [];
  }
  const entry = {
    ts: nowEpochSeconds(),
    operation: typeof op.operation === "string" ? op.operation : "Unknown",
    trustId: typeof op.trustId === "string" ? op.trustId : undefined,
    fromHash: typeof op.fromHash === "string" ? op.fromHash : undefined,
    toHash: typeof op.toHash === "string" ? op.toHash : undefined,
    reason: typeof op.reason === "string" ? op.reason : undefined,
    ok: op.ok !== false,
  };
  session.trustOpsLog.push(entry);
  session.updatedAt = entry.ts;
  return entry;
}

export function getTrustOps(runtimeState, sessionId) {
  const session = getSession(runtimeState, sessionId);
  return Array.isArray(session?.trustOpsLog) ? session.trustOpsLog : [];
}
