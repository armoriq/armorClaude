// Every process that records a session ships its own copy of the session's
// root span; the backend merges copies that share a span id.
import armoriqSdk from "@armoriq/sdk-dev";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sanitizeParams, redactSecrets } from "./common.mjs";
import { appendDaemonLog } from "./daemon-log.mjs";
import { obsLeaseMiss, obsLeaseStore } from "./obs-lease-store.mjs";
import { SPOOL_MAX_TRIES, shipRetryDelayMs, shipSpool, writeSpoolBatch } from "./obs-spool.mjs";
import { claimRootStart, releaseRootStart, rootStartReleased } from "./obs-root-marker.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;

const EXPORT_DRAIN_MARGIN_MS = 1_000;
const HOOK_LEASE_WAIT_MS = 1_500;
const LEASE_FETCHER = fileURLToPath(new URL("../obs-lease-fetch.mjs", import.meta.url));

const sessions = new Map();
const queues = new Map();
const shippers = new Map();
let shipping = false;
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

function logObs(config, message) {
  try {
    appendDaemonLog(config.dataDir, `[armorclaude-obs] ${message} pid=${process.pid}`);
  } catch {
    /* the log is best-effort */
  }
}

function getOrInitEntry(sessionId, config) {
  let entry = sessions.get(sessionId);
  if (entry) return Promise.resolve(entry);
  return initEntry(sessionId, config);
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

function spoolSink(config) {
  return { write: (batch) => safeObsAsync(() => writeSpoolBatch(config.dataDir, batch)) };
}

function dataDirOptions(config) {
  const leaseStore = obsLeaseStore(config.dataDir, config.observabilityEndpoint, config.apiKey);
  return drainOnClose ? { leaseStore } : { leaseStore, spanSink: spoolSink(config) };
}

function runtimeOptionsFor(config) {
  const sdkVersion = typeof armoriqSdk.VERSION === "string" ? armoriqSdk.VERSION : "unknown";
  const runtimeOptions = {
    backendEndpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    sdkVersion,
    options: { serviceName: config.observabilityProduct || "armorclaude" },
  };
  if (config.dataDir) Object.assign(runtimeOptions, dataDirOptions(config));
  if (testHooks?.leaseFetcher) runtimeOptions.leaseFetcher = testHooks.leaseFetcher;
  if (testHooks?.tracerProvider) {
    runtimeOptions.options = {
      ...runtimeOptions.options,
      exporter: "provider",
      tracerProvider: testHooks.tracerProvider,
    };
  }
  return runtimeOptions;
}

async function initEntry(sessionId, config) {
  const runtime = new ArmorIQTelemetryRuntime(runtimeOptionsFor(config));
  const startTime = await rootStartTime(sessionId, config);
  const session = new OtelSession(runtime, {
    sessionId,
    agentId: config.agentId || null,
    userId: config.userId || null,
    root: { ...sessionRootIds(sessionId), startTime },
  });
  const entry = { runtime, session, dataDir: startTime && config.dataDir, lastEventAt: Date.now() };
  sessions.set(sessionId, entry);
  if (shipping && config.dataDir) shipperFor(config);
  await (drainOnClose
    ? safeObsAsync(() => session.refreshPolicy())
    : awaitHookLease(entry, config));
  await safeObsAsync(() => session.beginRoot({ input: connectedInput(config) }));
  return entry;
}

function shipperFor(config) {
  const key = `${config.dataDir}\n${config.observabilityEndpoint}\n${config.apiKey}`;
  let shipper = shippers.get(key);
  if (shipper) return shipper;
  const runtime = new ArmorIQTelemetryRuntime(runtimeOptionsFor(config));
  shipper = {
    config,
    dataDir: config.dataDir,
    binding: runtime.spoolBinding,
    runtime,
    skip: new Set(),
    running: null,
    again: false,
    failures: 0,
    retryAt: 0,
    timer: null,
  };
  shippers.set(key, shipper);
  shipNow(shipper);
  return shipper;
}

async function shipRound(shipper) {
  const options = { skip: shipper.skip, ...(shipper.failures > 0 ? { limit: 1 } : {}) };
  const round = await safeObsAsync(() =>
    shipSpool(shipper.dataDir, shipper.binding, shipper.runtime, options)
  );
  if (round?.dropped) {
    logObs(
      shipper.config,
      `dropped ${round.dropped} spooled batch(es) after ${SPOOL_MAX_TRIES} failed exports`
    );
  }
  return round;
}

function wakeAt(shipper, at) {
  if (!Number.isFinite(at)) return;
  clearTimeout(shipper.timer);
  shipper.timer = setTimeout(() => shipNow(shipper), Math.max(0, at - Date.now()));
  shipper.timer.unref();
}

function retryLater(shipper) {
  shipper.failures += 1;
  shipper.retryAt = Date.now() + shipRetryDelayMs(shipper.failures);
  wakeAt(shipper, shipper.retryAt);
}

const backOff = (shipper, round) =>
  !round || (round.settled === 0 && (round.outage || (shipper.failures > 0 && round.shipped > 0)));
const moreDue = (shipper, round) =>
  shipper.again || (!releasingAll && round.more && round.settled > 0);

async function shipRounds(shipper) {
  for (;;) {
    shipper.again = false;
    const round = await shipRound(shipper);
    if (backOff(shipper, round)) return retryLater(shipper);
    if (round.settled > 0) shipper.failures = 0;
    if (!moreDue(shipper, round)) {
      return wakeAt(shipper, Math.max(round.nextDueAt, shipper.retryAt));
    }
  }
}

function shipNow(shipper) {
  if (shipper.running) {
    shipper.again = true;
    return shipper.running;
  }
  shipper.running = shipRounds(shipper).finally(() => (shipper.running = null));
  return shipper.running;
}

export function obsShipSpools(config) {
  shipping = true;
  if (isObsEnabled(config) && config.dataDir) shipperFor(config);
}

const shipDue = (shipper) => (Date.now() >= shipper.retryAt ? shipNow(shipper) : shipper.running);

export function obsRetrySpools() {
  return Promise.all([...shippers.values()].map(shipDue));
}

async function closeShippers() {
  const all = [...shippers.values()];
  shippers.clear();
  await Promise.all(
    all.map(async (shipper) => {
      clearTimeout(shipper.timer);
      await shipper.running;
      await safeObsAsync(() => shipper.runtime.close());
    })
  );
}

function within(promise, ms) {
  let timer;
  const expired = new Promise((resolve) => (timer = setTimeout(resolve, ms)));
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

async function awaitHookLease(entry, config) {
  const miss = config.dataDir
    ? obsLeaseMiss(config.dataDir, config.observabilityEndpoint, config.apiKey)
    : null;
  if (await safeObsAsync(() => miss?.recent())) return;
  const answered = await within(
    safeObsAsync(() => entry.session.refreshPolicy()).then(() => true),
    HOOK_LEASE_WAIT_MS
  );
  if (entry.runtime.currentCeilingSnapshot().authoritative || !miss) return;
  await safeObsAsync(() => miss.record());
  if (!answered) await safeObsAsync(async () => fetchLeaseInBackground(config));
}

function fetchLeaseInBackground({ dataDir, observabilityEndpoint, apiKey }) {
  const child = spawn(process.execPath, [LEASE_FETCHER], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify({ dataDir, observabilityEndpoint, apiKey }));
  child.unref();
}

export async function obsFetchLease(config) {
  const runtime = new ArmorIQTelemetryRuntime(runtimeOptionsFor(config));
  await safeObsAsync(() => runtime.refreshPolicy());
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
  shippers.clear();
  shipping = false;
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

function toolCall(input, config) {
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  const toolCallId = typeof input.tool_use_id === "string" ? input.tool_use_id : undefined;
  return { toolName, toolCallId, arguments: sanitizeParams(input.tool_input, config.sanitize) };
}

async function obsCheck(sessionId, config, input, output) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(() =>
    entry.session.recordPolicy(toolCall(input, config), { decision: classifyDecision(output) })
  );
}

async function obsReport(sessionId, config, input, outcome) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    const call = toolCall(input, config);
    await entry.session.recordTool(
      { ...call, operation: { category: operationCategory(call.toolName) } },
      {
        outcome,
        result: redactSecrets(sanitizeParams(input.tool_response, config.sanitize)),
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
  await closeShippers();
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
        await obsCheck(sessionId, config, input, output);
        break;
      case "PostToolUse":
        await obsReport(sessionId, config, input, "success");
        break;
      case "PostToolUseFailure":
        await obsReport(sessionId, config, input, "error");
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
