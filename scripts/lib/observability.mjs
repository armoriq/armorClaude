/**
 * armorClaude observability bridge — additive, fail-open.
 *
 * Owns a module-level per-session registry of SDK OtelSessions, each with its
 * own ArmorIQTelemetryRuntime (a session close shuts its runtime down, so
 * runtimes cannot be shared across sessions). In the daemon (one long-lived
 * process) the registry persists across a session's hook events; in the
 * in-process fallback every hook process has its own registry.
 *
 * One trace per Claude Code session, whichever processes record it: the trace
 * id and root span id derive from the session id, and the root's start time
 * comes from a marker file that the first process to record the session
 * creates. That process and SessionEnd end the root; any other process ships
 * its spans under the root without ending it. The backend merges the two root
 * deliveries, which share a span id.
 *
 * Event mapping (one-shot record calls — each hook event is a complete fact):
 * One root span per session: the first event opens it, SessionEnd ends it.
 *   SessionStart      -> opens the root with a connect input
 *   UserPromptSubmit  -> opens the root with the sanitized prompt as input,
 *                        unless an earlier event opened it
 *   PreToolUse        -> policy evaluate span with the allow/block/hold verdict
 *   PostToolUse       -> tool span with success/error outcome
 *   UserPromptExpansion (slash command) -> command operation span
 *   Stop              -> ends the open plan span, if any, and flushes
 *   SessionEnd        -> ends the root as completed, opening one if no earlier
 *                        event did, and drops the entry
 *
 * Each session's events are recorded in arrival order on a per-session queue.
 * NOTHING here may throw into a hook: every emission goes through safeObsAsync().
 */
import armoriqSdk from "@armoriq/sdk-dev";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeParams, redactSecrets } from "./common.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;

// sessionId -> { runtime, session, ownsRoot }
const sessions = new Map();

// sessionId -> promise that settles once that session's last queued event is recorded
const queues = new Map();

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

async function settledWithin(ms, promise) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, ms).unref();
  });
  try {
    return await Promise.race([promise.catch(() => undefined), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function sessionRootIds(sessionId) {
  return {
    traceId: sha256(`armorclaude.trace:${sessionId}`).slice(0, 32),
    spanId: sha256(`armorclaude.root:${sessionId}`).slice(0, 16),
  };
}

function rootMarkerPath(config, sessionId) {
  return path.join(config.dataDir, "obs-roots", sha256(sessionId).slice(0, 32));
}

// The first process to record a session links its marker into place, so the
// marker is never seen half-written. Without a data dir to coordinate in,
// every process ends its own copy of the root, still in the one trace.
async function claimRootStart(sessionId, config) {
  const now = new Date();
  if (!config.dataDir) return { startTime: now, ownsRoot: true };
  const marker = rootMarkerPath(config, sessionId);
  const draft = `${marker}.${randomUUID()}`;
  try {
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(draft, now.toISOString());
    await link(draft, marker);
    return { startTime: now, ownsRoot: true };
  } catch (err) {
    if (err?.code !== "EEXIST") return { startTime: now, ownsRoot: true };
    const recorded = new Date((await readFile(marker, "utf8")).trim());
    return {
      startTime: Number.isFinite(recorded.getTime()) ? recorded : now,
      ownsRoot: false,
    };
  } finally {
    await rm(draft, { force: true });
  }
}

async function releaseRootStart(sessionId, config) {
  if (!config.dataDir) return;
  await rm(rootMarkerPath(config, sessionId), { force: true });
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
  const { startTime, ownsRoot } = (await safeObsAsync(() => claimRootStart(sessionId, config))) ?? {
    startTime: new Date(),
    ownsRoot: true,
  };
  const session = new OtelSession(runtime, {
    sessionId,
    agentId: config.agentId || null,
    userId: config.userId || null,
    root: { ...sessionRootIds(sessionId), startTime },
  });
  const entry = { runtime, session, ownsRoot };
  sessions.set(sessionId, entry);
  await settledWithin(500, session.refreshPolicy());
  return entry;
}

export function __resetObsForTests() {
  sessions.clear();
  queues.clear();
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

// The SDK accepts only tool names that start alphanumeric.
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

function connectedInput(config) {
  return `ArmorClaude connected (${config.observabilityProduct || "armorclaude"})`;
}

// Record that ArmorClaude connected to this Claude Code session. Emitted once,
// on SessionStart, on the session entry's root.
async function obsConnected(sessionId, config) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    await entry.session.beginRoot({ input: connectedInput(config) });
  });
}

// Turn boundary: ends the open plan span, if any, and flushes the runtime so
// this turn's spans ship. The root stays open until SessionEnd.
async function obsEndTurn(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  await safeObsAsync(() => entry.session.flush("ok"));
}

async function obsEndSession(sessionId, config) {
  const entry = await getOrInitEntry(sessionId, config);
  sessions.delete(sessionId);
  await safeObsAsync(async () => {
    // The daemon's root is already open; a fallback process opens it with the
    // same input the first process gave it.
    await entry.session.beginRoot({ input: connectedInput(config) });
    await entry.session.close("ok");
  });
  await safeObsAsync(() => releaseRootStart(sessionId, config));
}

// A process stops recording a session that may continue in another process.
// The root's owner ends it with status ok and task outcome unknown, since only
// SessionEnd states how the session ended; any other process ships its spans
// and leaves the root open.
async function releaseEntry(entry) {
  if (entry.ownsRoot) {
    await entry.session.close("ok", "unknown");
    return;
  }
  await entry.session.flush("ok");
  await entry.runtime.close();
}

// Daemon shutdown: waits for queued events, then releases every session so
// its spans ship before exit. Fail-open: never throws.
export async function obsFlushAll() {
  await Promise.all(queues.values());
  const open = [...sessions.values()];
  sessions.clear();
  await Promise.all(open.map((entry) => safeObsAsync(() => releaseEntry(entry))));
}

/**
 * Queues one hook event on its session's queue. The returned promise settles,
 * never rejecting, once the event is recorded. The daemon does not await it,
 * so its reply never waits on the policy lease or an export.
 */
export function observeHook(event, input, output, config) {
  if (!isObsEnabled(config)) return Promise.resolve();
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId) return Promise.resolve();
  const recorded = (queues.get(sessionId) ?? Promise.resolve()).then(() =>
    recordEvent(sessionId, event, input, output, config)
  );
  queues.set(sessionId, recorded);
  recorded.then(() => {
    if (queues.get(sessionId) === recorded) queues.delete(sessionId);
  });
  return recorded;
}

async function recordEvent(sessionId, event, input, output, config) {
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
        // Turn boundary: ships this turn's spans; the root stays open until
        // SessionEnd.
        await obsEndTurn(sessionId);
        break;
      case "SessionEnd":
        await obsEndSession(sessionId, config);
        break;
      default:
        break;
    }
  });
}

// In-process fallback, before the hook process exits: waits for the session's
// queued events, then releases the session, which continues in the next hook
// process.
export async function obsFlush(sessionId, config) {
  if (!isObsEnabled(config)) return;
  await queues.get(sessionId);
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  await safeObsAsync(() => releaseEntry(entry));
}
