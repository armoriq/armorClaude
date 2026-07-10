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

function endActiveTrace(entry) {
  if (!entry || !entry.traceCtx) return;
  safeObs(() => {
    if (entry.planStartSpanId) {
      closeSpan(entry.recorder, entry.traceCtx, entry.planStartSpanId, { status: "ok" });
    }
    endTrace(entry.recorder, entry.traceCtx, { status: "ok" });
  });
  entry.traceCtx = null;
  entry.planStartSpanId = null;
}

function startPlanTrace(entry, sessionId, attrs) {
  const sid = isValidUuid && isValidUuid(sessionId) ? sessionId : null;
  entry.traceCtx = startTrace(entry.recorder, "iap.plan", attrs, sid);
  return entry.traceCtx;
}

function ensureTrace(entry, sessionId) {
  if (entry.traceCtx) return entry.traceCtx;
  return safeObs(() => startPlanTrace(entry, sessionId, { source: "claude-code", lazy: true })) ?? null;
}

function classifyDecision(output) {
  const d = output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision;
  if (d === "deny") return "deny";
  if (d === "ask") return "ask";
  return "allow";
}

function obsStartPlan(sessionId, config, prompt) {
  const entry = getOrInitRecorder(sessionId, config);
  endActiveTrace(entry); // close previous turn's trace, if any
  safeObs(() => {
    const ctx = startPlanTrace(entry, sessionId, { source: "claude-code" });
    entry.planStartSpanId = openSpan(entry.recorder, ctx, {
      name: "iap.plan.start",
      attributes: { prompt: sanitizeParams(prompt, config.sanitize) },
    });
  });
}

function obsCheck(sessionId, config, toolName, toolInput, output) {
  const entry = getOrInitRecorder(sessionId, config);
  const ctx = ensureTrace(entry, sessionId);
  if (!ctx) return;
  safeObs(() => {
    const decision = classifyDecision(output);
    const status = decision === "deny" ? "denied" : "ok";
    const reason =
      (output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecisionReason) || null;
    const checkSpanId = openSpan(entry.recorder, ctx, {
      name: "iap.check",
      attributes: { toolName },
    });
    recordPolicyCall(
      entry.recorder,
      ctx,
      {
        kind: "policy_call",
        policyId: null,
        policyName: null,
        policyHash: null,
        policyVersion: null,
        decision,
        matchedRuleId: null,
        dataClasses: [],
        reason,
        input: sanitizeParams(toolInput, config.sanitize),
        output: null,
        source: "sdk",
        enforcementAction: decision === "deny" ? "block" : "allow",
        obligations: null,
        delegationId: null,
      },
      checkSpanId
    );
    closeSpan(entry.recorder, ctx, checkSpanId, { status });
  });
}

function obsReport(sessionId, config, toolName, toolInput, toolResponse, status) {
  const entry = getOrInitRecorder(sessionId, config);
  const ctx = ensureTrace(entry, sessionId);
  if (!ctx) return;
  safeObs(() => {
    const spanId = openSpan(entry.recorder, ctx, {
      name: "tool.report",
      attributes: {
        toolName: toolName || null,
        input: sanitizeParams(toolInput, config.sanitize),
        output: redactSecrets(sanitizeParams(toolResponse, config.sanitize)),
      },
    });
    closeSpan(entry.recorder, ctx, spanId, { status: status || "ok" });
  });
}

async function obsEndSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  endActiveTrace(entry);
  await safeObsAsync(() => flushObservability(entry.recorder));
  // Stop the per-session shipper timer (unref'd, but tidy up in the long-lived daemon).
  safeObs(() => entry.recorder.__shipper && entry.recorder.__shipper.stop());
  sessions.delete(sessionId);
}

export async function observeHook(event, input, output, config) {
  if (!isObsEnabled(config)) return;
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId) return;
  await safeObsAsync(async () => {
    switch (event) {
      case "UserPromptSubmit":
        obsStartPlan(sessionId, config, typeof input.prompt === "string" ? input.prompt : "");
        break;
      case "PreToolUse":
        obsCheck(
          sessionId,
          config,
          typeof input.tool_name === "string" ? input.tool_name : "",
          input.tool_input,
          output
        );
        break;
      case "PostToolUse":
        obsReport(sessionId, config, input.tool_name, input.tool_input, input.tool_response, "ok");
        break;
      case "PostToolUseFailure":
        obsReport(sessionId, config, input.tool_name, input.tool_input, input.tool_response, "error");
        break;
      case "SessionEnd":
        await obsEndSession(sessionId);
        break;
      default:
        break;
    }
  });
}

// In-process fallback safety net: force-flush a session's recorder.
export async function obsFlush(sessionId, config) {
  if (!isObsEnabled(config)) return;
  const entry = sessions.get(sessionId);
  if (!entry) return;
  await safeObsAsync(() => flushObservability(entry.recorder));
}
