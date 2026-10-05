// Every process that records a session ships its own copy of the session's
// root span; the backend merges copies that share a span id.
import armoriqSdk from "@armoriq/sdk-dev";
import { createHash } from "node:crypto";
import { sanitizeParams, redactSecrets } from "./common.mjs";
import { claimRootStart, releaseRootStart, rootStartReleased } from "./obs-root-marker.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;

const EXPORT_DRAIN_MARGIN_MS = 1_000;

const sessions = new Map();
const queues = new Map();
let testHooks = null;
let releasingAll = null;
let drainOnClose = false;

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

async function rootStartTime(sessionId, config) {
  return config.dataDir ? claimRootStart(config.dataDir, sessionId) : null;
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
  const startTime = await rootStartTime(sessionId, config);
  const session = new OtelSession(runtime, {
    sessionId,
    agentId: config.agentId || null,
    userId: config.userId || null,
    root: { ...sessionRootIds(sessionId), startTime },
  });
  const entry = { runtime, session, dataDir: startTime && config.dataDir, lastEventAt: Date.now() };
  sessions.set(sessionId, entry);
  await settledWithin(500, session.refreshPolicy());
  await safeObsAsync(() => session.beginRoot({ input: connectedInput(config) }));
  return entry;
}

export function obsDrainExportsOnClose() {
  drainOnClose = true;
}

function closeDeadlineMs(entry) {
  return drainOnClose ? entry.runtime.config.timeoutMillis + EXPORT_DRAIN_MARGIN_MS : undefined;
}

export function __resetObsForTests() {
  sessions.clear();
  queues.clear();
  releasingAll = null;
  drainOnClose = false;
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

async function obsEndTurn(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  await safeObsAsync(() => entry.session.flush("ok"));
}

async function obsEndSession(sessionId, config) {
  const entry = await getOrInitEntry(sessionId, config);
  sessions.delete(sessionId);
  await safeObsAsync(() =>
    entry.session.close({ status: "ok", deadlineMs: closeDeadlineMs(entry) })
  );
  if (config.dataDir) await safeObsAsync(() => releaseRootStart(config.dataDir, sessionId));
}

async function releaseSession(sessionId, entry) {
  sessions.delete(sessionId);
  await safeObsAsync(async () => {
    const ended = entry.dataDir && (await rootStartReleased(entry.dataDir, sessionId));
    const deadlineMs = closeDeadlineMs(entry);
    if (ended) return entry.runtime.close(deadlineMs);
    // unknown, not process_exit: the session may go on in another process, and
    // only SessionEnd knows how it ended.
    await entry.session.close({
      status: "ok",
      taskOutcome: "unknown",
      output: {},
      endTime: new Date(entry.lastEventAt),
      deadlineMs,
    });
  });
}

function enqueue(sessionId, task) {
  const done = (queues.get(sessionId) ?? Promise.resolve()).then(task);
  queues.set(sessionId, done);
  done.then(() => {
    if (queues.get(sessionId) === done) queues.delete(sessionId);
  });
  return done;
}

async function releaseAll() {
  await Promise.all(queues.values());
  await Promise.all([...sessions].map(([sessionId, entry]) => releaseSession(sessionId, entry)));
}

export function obsFlushAll() {
  releasingAll ??= releaseAll();
  return releasingAll;
}

export function obsReleaseIdle(maxIdleMs) {
  if (releasingAll) return Promise.resolve();
  const idleSince = Date.now() - maxIdleMs;
  const idle = [...sessions].filter(([, entry]) => entry.lastEventAt <= idleSince);
  return Promise.all(
    idle.map(([sessionId, entry]) =>
      enqueue(sessionId, () => {
        if (sessions.get(sessionId) === entry && entry.lastEventAt <= idleSince) {
          return releaseSession(sessionId, entry);
        }
      })
    )
  );
}

export function observeHook(event, input, output, config) {
  if (!isObsEnabled(config) || releasingAll) return Promise.resolve();
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId) return Promise.resolve();
  return enqueue(sessionId, () => recordEvent(sessionId, event, input, output, config));
}

async function recordEvent(sessionId, event, input, output, config) {
  await safeObsAsync(async () => {
    switch (event) {
      case "SessionStart":
      case "UserPromptSubmit":
        await getOrInitEntry(sessionId, config);
        break;
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
        await obsEndTurn(sessionId);
        break;
      case "SessionEnd":
        await obsEndSession(sessionId, config);
        break;
      default:
        break;
    }
  });
  const entry = sessions.get(sessionId);
  if (entry) entry.lastEventAt = Date.now();
}

export async function obsFlush(sessionId, config) {
  if (!isObsEnabled(config)) return;
  const entry = sessions.get(sessionId);
  if (entry) await releaseSession(sessionId, entry);
}
