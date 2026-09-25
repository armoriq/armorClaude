/**
 * armorClaude observability bridge — additive, fail-open.
 *
 * Owns a module-level per-session registry of SDK OtelSessions, each with its
 * own ArmorIQTelemetryRuntime (a session close shuts its runtime down, so
 * runtimes cannot be shared across sessions). In the daemon (one long-lived
 * process) the registry persists across a session's hook events; in the
 * in-process fallback the registry is per-process (flat, best-effort).
 *
 * Event mapping (one-shot record calls — each hook event is a complete fact):
 *   UserPromptSubmit  -> turn root with the sanitized prompt as input
 *   PreToolUse        -> policy evaluate span with the allow/block/hold verdict
 *   PostToolUse       -> tool span with success/error outcome
 *   UserPromptExpansion (slash command) -> command operation span
 *   SessionStart      -> connect root on the session entry
 *   Stop              -> flush the turn (root stays open for the next turn)
 *   SessionEnd        -> close the session and drop the entry
 *
 * NOTHING here may throw into a hook: every emission goes through safeObs().
 */
import armoriqSdk from "@armoriq/sdk-dev";
import { sanitizeParams, redactSecrets } from "./common.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;

// sessionId -> { runtime, session }
const sessions = new Map();

// Test-only injection (lease + tracer provider). Production always uses the
// backend lease endpoint and the SDK-owned exporter.
let testHooks = null;

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

function getOrInitEntry(sessionId, config) {
  let entry = sessions.get(sessionId);
  if (entry) return Promise.resolve(entry);
  return initEntry(sessionId, config);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function initEntry(sessionId, config) {
  const sdkVersion = typeof armoriqSdk.VERSION === "string" ? armoriqSdk.VERSION : "unknown";
  const runtimeOptions = {
    backendEndpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    sdkVersion,
    options: { serviceName: config.observabilityProduct || "armorclaude" },
  };
  if (testHooks?.leaseFetcher) runtimeOptions.leaseFetcher = testHooks.leaseFetcher;
  if (testHooks?.tracerProvider) {
    runtimeOptions.options = {
      ...runtimeOptions.options,
      exporter: "provider",
      tracerProvider: testHooks.tracerProvider,
    };
  }
  const runtime = new ArmorIQTelemetryRuntime(runtimeOptions);
  const session = new OtelSession(runtime, {
    sessionId,
    agentId: config.agentId || null,
    userId: config.userId || null,
  });
  const entry = { runtime, session };
  sessions.set(sessionId, entry);
  // Warm the policy lease so this session's first event is governed by a real
  // answer instead of racing the background fetch (a cold runtime fails
  // closed and would silently drop it). Bounded and fail-open: a slow backend
  // delays this event by at most the race window, never breaks it.
  await Promise.race([session.refreshPolicy().catch(() => undefined), delay(500)]);
  return entry;
}

export function __resetObsForTests() {
  sessions.clear();
}

export function __setOtelTestHooksForTests(hooks) {
  testHooks = hooks || null;
}

function classifyDecision(output) {
  const d = output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision;
  if (d === "deny") return "block";
  if (d === "ask") return "hold";
  return "allow";
}

function operationCategory(toolName) {
  return typeof toolName === "string" && toolName.startsWith("mcp__") ? "mcp" : "tool";
}

async function obsStartPlan(sessionId, config, prompt) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    const { prompt: sanitizedInput } = sanitizeParams({ prompt }, config.sanitize);
    await entry.session.beginRoot({ input: sanitizedInput ?? null });
  });
}

async function obsCheck(sessionId, config, toolName, toolInput, output) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    const reason =
      (output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecisionReason) ||
      undefined;
    await entry.session.recordPolicy(
      { toolName, arguments: sanitizeParams(toolInput, config.sanitize) },
      { decision: classifyDecision(output), ...(reason ? { policyReasonCode: reason } : {}) }
    );
  });
}

async function obsReport(sessionId, config, toolName, toolInput, toolResponse, outcome) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    await entry.session.recordTool(
      {
        toolName,
        arguments: sanitizeParams(toolInput, config.sanitize),
        operation: { category: operationCategory(toolName) },
      },
      {
        outcome,
        result: redactSecrets(sanitizeParams(toolResponse, config.sanitize)),
      }
    );
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

// Record a slash-command invocation as a command operation on the current
// turn's trace, so the dashboard session view can show which slash commands a
// session ran. The SDK only accepts identifier-safe tool names (must start
// alphanumeric), so the leading slash is stripped: "/deploy" is recorded as
// tool "deploy" under the command category.
async function obsSlashCommand(sessionId, config, command) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    await entry.session.recordOperation({
      category: "command",
      name: "command.execute",
      toolName: command.replace(/^\//, ""),
    });
  });
}

// Record that ArmorClaude connected to this Claude Code session. Emitted once,
// on SessionStart, on the session entry's root.
async function obsConnected(sessionId, config) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    await entry.session.beginRoot({
      input: `ArmorClaude connected (${config.observabilityProduct || "armorclaude"})`,
    });
  });
}

// Turn boundary: flush the turn's plan spans so per-turn evidence ships
// mid-session. The root stays open for the next turn; the entry (and its
// runtime) is dropped only on SessionEnd.
async function obsEndTurn(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  await safeObsAsync(() => entry.session.flush("ok"));
}

async function obsEndSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  await safeObsAsync(() => entry.session.close("ok"));
}

// Flush every live session's runtime without ending traces. Used by the daemon
// on shutdown / idle-timeout so buffered spans ship before exit.
// Fail-open: never throws.
export async function obsFlushAll() {
  for (const entry of sessions.values()) {
    await safeObsAsync(() => entry.runtime.forceFlush());
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
        await obsConnected(sessionId, config);
        break;
      case "UserPromptSubmit": {
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        await obsStartPlan(sessionId, config, prompt);
        break;
      }
      case "UserPromptExpansion": {
        const slash = expandedSlashCommand(input);
        if (slash) await obsSlashCommand(sessionId, config, slash);
        break;
      }
      case "PreToolUse":
        await obsCheck(
          sessionId,
          config,
          typeof input.tool_name === "string" ? input.tool_name : "",
          input.tool_input,
          output
        );
        break;
      case "PostToolUse":
        await obsReport(
          sessionId,
          config,
          input.tool_name,
          input.tool_input,
          input.tool_response,
          "success"
        );
        break;
      case "PostToolUseFailure":
        await obsReport(
          sessionId,
          config,
          input.tool_name,
          input.tool_input,
          input.tool_response,
          "error"
        );
        break;
      case "Stop":
        // Turn boundary: flush the turn's plan spans so per-turn evidence
        // ships mid-session instead of buffering the whole session until
        // SessionEnd. A fresh turn starts on the next UserPromptSubmit.
        await obsEndTurn(sessionId);
        break;
      case "SessionEnd":
        await obsEndSession(sessionId);
        break;
      default:
        break;
    }
  });
}

// In-process fallback safety net: force-flush a session's runtime.
export async function obsFlush(sessionId, config) {
  if (!isObsEnabled(config)) return;
  const entry = sessions.get(sessionId);
  if (!entry) return;
  await safeObsAsync(() => entry.runtime.forceFlush());
}
