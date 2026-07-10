/**
 * armorClaude observability bridge — additive, fail-open.
 *
 * Owns a module-level per-session registry of SDK ObservabilityRecorders.
 * In the daemon (one long-lived process) the registry persists across a
 * session's hook events, giving nested Model A traces + background flush.
 * In the in-process fallback the registry is per-process (flat, best-effort).
 *
 * NOTHING here may throw into a hook: every emission goes through safeObs().
 */
import armoriqSdk from "@armoriq/sdk";
import { sanitizeParams, redactSecrets } from "./common.mjs";

const {
  ObservabilityRecorder,
  startTrace,
  openSpan,
  closeSpan,
  endTrace,
  recordPolicyCall,
  flushObservability,
  isValidUuid,
} = armoriqSdk;

// sessionId -> { recorder, traceCtx, planStartSpanId }
const sessions = new Map();

function safeObs(fn) {
  try {
    return fn();
  } catch (err) {
    if (process.env.ARMORCLAUDE_DEBUG) {
      process.stderr.write(`[armorclaude-obs] ${err?.message ?? err}\n`);
    }
    return undefined;
  }
}

async function safeObsAsync(fn) {
  try {
    return await fn();
  } catch (err) {
    if (process.env.ARMORCLAUDE_DEBUG) {
      process.stderr.write(`[armorclaude-obs] ${err?.message ?? err}\n`);
    }
    return undefined;
  }
}

export function isObsEnabled(config) {
  return Boolean(config && config.observabilityEnabled);
}

function getOrInitRecorder(sessionId, config) {
  let entry = sessions.get(sessionId);
  if (entry) return entry;
  const recorder = new ObservabilityRecorder({
    enabled: true,
    endpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    product: config.observabilityProduct,
    sessionId: isValidUuid && isValidUuid(sessionId) ? sessionId : null,
    userId: config.userId || null,
    agentId: config.agentId || null,
  });
  entry = { recorder, traceCtx: null, planStartSpanId: null };
  sessions.set(sessionId, entry);
  return entry;
}

export function __resetObsForTests() {
  sessions.clear();
}
