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
    // trace.sessionId and trace.userId are UUID-typed columns on the backend
    // (obs_traces.session_id/user_id, and the ingest zod schema enforces
    // z.uuid() for userId) — armorClaude's config uses logical, non-UUID ids
    // ("claude-user"/"aaaa-session-slug") for these, so they're only sent
    // when they're real UUIDs; otherwise null (the backend attributes the
    // request's identity from the API key regardless).
    //
    // trace.agentId, by contrast, is a free-form `text` column with NO UUID
    // requirement on the backend (ingest schema: `agentId: z.string()`, no
    // `.uuid()`) — armorClaude's logical id ("claude-code") is a valid value
    // as-is. It was PREVIOUSLY (incorrectly) gated behind the same
    // isValidUuid check as sessionId/userId, which silently nulled agentId
    // on every armorClaude trace; that was the root cause of the
    // dashboard's empty AGENT column.
    sessionId: isValidUuid && isValidUuid(sessionId) ? sessionId : null,
    userId: isValidUuid && isValidUuid(config.userId) ? config.userId : null,
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
  return (
    safeObs(() => startPlanTrace(entry, sessionId, { source: "claude-code", lazy: true })) ?? null
  );
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
    // Trace-level `input`: the turn's goal/intent string, sanitized+truncated
    // the same way tool params are (config.sanitize) — this is what the
    // dashboard's trace-list INPUT column reads (attributes.input). Kept
    // alongside (not instead of) the existing span-level `prompt` attribute
    // on `iap.plan.start`, which callers of the raw span tree still rely on.
    const { prompt: sanitizedInput } = sanitizeParams({ prompt }, config.sanitize);
    const ctx = startPlanTrace(entry, sessionId, {
      source: "claude-code",
      input: sanitizedInput ?? null,
    });
    // sanitizeParams sanitizes the string VALUES of an object; passing a bare
    // string returns {}, so wrap the prompt to get a truncated string back.
    entry.planStartSpanId = openSpan(entry.recorder, ctx, {
      name: "iap.plan.start",
      attributes: sanitizeParams({ prompt }, config.sanitize),
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
      (output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecisionReason) ||
      null;
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
        // Distinguishes an MCP tool call (`mcp__server__tool`) from a plain
        // tool so the dashboard can bucket a session's MCP activity separately.
        // The `tool.report` span is the EXECUTION record — the earlier
        // `iap.check` span carries the same toolName but is the policy
        // pre-check, so aggregations count executions here, not there.
        operationCategory:
          typeof toolName === "string" && toolName.startsWith("mcp__") ? "mcp" : "tool",
        input: sanitizeParams(toolInput, config.sanitize),
        output: redactSecrets(sanitizeParams(toolResponse, config.sanitize)),
      },
    });
    closeSpan(entry.recorder, ctx, spanId, { status: status || "ok" });
  });
}

// Only structured expansion events confirm command activity. Keep the label
// bounded and reject arguments rather than treating arbitrary prompt text as
// execution evidence.
function expandedSlashCommand(input) {
  if (input.expansion_type !== "slash_command" || typeof input.command_name !== "string") {
    return null;
  }
  const name = input.command_name.trim();
  const command = name.startsWith("/") ? name : `/${name}`;
  if (
    command.length <= 1 ||
    command.length > 80 ||
    command.startsWith("//") ||
    /\s/.test(command)
  ) {
    return null;
  }
  return command;
}

// Record a slash-command invocation as a span on the current turn's trace, so
// the dashboard session view can show which slash commands a session ran. The
// `slashCommand` attribute is what the backend session-activity rollup reads.
function obsSlashCommand(sessionId, config, command) {
  const entry = getOrInitRecorder(sessionId, config);
  const ctx = ensureTrace(entry, sessionId);
  if (!ctx) return;
  safeObs(() => {
    const spanId = openSpan(entry.recorder, ctx, {
      name: "slash.command",
      attributes: { operationCategory: "command", slashCommand: command },
    });
    closeSpan(entry.recorder, ctx, spanId, { status: "ok" });
  });
}

// Record that ArmorClaude connected to this Claude Code session. Emitted once,
// on SessionStart, as its own short-lived trace so it ships independently of
// any turn. This is the "ArmorClaude is connected to Claude" signal the
// dashboard uses to show active plugin sessions.
function obsConnected(sessionId, config) {
  const entry = getOrInitRecorder(sessionId, config);
  safeObs(() => {
    const sid = isValidUuid && isValidUuid(sessionId) ? sessionId : null;
    const ctx = startTrace(
      entry.recorder,
      "armorclaude.session",
      { source: "claude-code", event: "connected" },
      sid
    );
    const spanId = openSpan(entry.recorder, ctx, {
      name: "armorclaude.connected",
      attributes: {
        kind: "event",
        level: "info",
        message: "ArmorClaude connected to Claude Code",
        operationCategory: "connect",
        product: config.observabilityProduct || config.productSlug || "armorclaude",
        llmId: config.llmId || "claude-code",
      },
    });
    closeSpan(entry.recorder, ctx, spanId, { status: "ok" });
    endTrace(entry.recorder, ctx, { status: "ok" });
  });
}

// End (but do not tear down) the active turn's trace. Handing the trace to the
// SDK shipper via endTrace() is what makes it eligible for the background 5s
// flush — until the trace ends, all its spans sit un-shipped in memory (SDK
// only enqueues ENDED traces). Called on Stop (turn end) so each turn's trace
// ships mid-session; the recorder + its shipper stay alive for the next turn.
function obsEndTurn(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry || !entry.traceCtx) return;
  endActiveTrace(entry);
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

// Flush every live session's recorder without ending traces. Used by the daemon
// on shutdown / idle-timeout so any already-ended turn traces ship before exit.
// Fail-open: never throws.
export async function obsFlushAll() {
  for (const entry of sessions.values()) {
    await safeObsAsync(() => flushObservability(entry.recorder));
  }
}

export async function observeHook(event, input, output, config) {
  if (!isObsEnabled(config)) return;
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId) return;
  await safeObsAsync(async () => {
    switch (event) {
      case "SessionStart":
        // "ArmorClaude connected to Claude" — one connect record per session.
        obsConnected(sessionId, config);
        break;
      case "UserPromptSubmit": {
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        obsStartPlan(sessionId, config, prompt);
        break;
      }
      case "UserPromptExpansion": {
        const slash = expandedSlashCommand(input);
        if (slash) obsSlashCommand(sessionId, config, slash);
        break;
      }
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
        obsReport(
          sessionId,
          config,
          input.tool_name,
          input.tool_input,
          input.tool_response,
          "error"
        );
        break;
      case "Stop":
        // Turn boundary: end the active trace so it ships mid-session via the
        // SDK's background shipper, instead of buffering the whole session
        // until SessionEnd. A fresh trace opens lazily on the next tool call
        // (or explicitly on the next UserPromptSubmit).
        obsEndTurn(sessionId);
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
