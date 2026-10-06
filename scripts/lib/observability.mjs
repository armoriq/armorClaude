// Every process that records a session ships its own copy of the session's
// root span; the backend merges copies that share a span id.
import armoriqSdk from "@armoriq/sdk-dev";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sanitizeParams, redactSecrets } from "./common.mjs";
import { appendDaemonLog } from "./daemon-log.mjs";
import { DECISION_CODE } from "./hook-output.mjs";
import { obsLeaseMiss, obsLeaseStore } from "./obs-lease-store.mjs";
import {
  batchCalls,
  eventCall,
  forgetEvent,
  journalBacklog,
  journalEntryPath,
  journalEvent,
  pruneJournal,
  settledEvents,
} from "./obs-journal.mjs";
import { SPOOL_MAX_TRIES, shipRetryDelayMs, shipSpool, writeSpoolBatch } from "./obs-spool.mjs";
import { claimRootStart, markRootEnded, rootEndedAt } from "./obs-root-marker.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;

const HOOK_LEASE_WAIT_MS = 1_500;
const LEASE_FETCHER = fileURLToPath(new URL("../obs-lease-fetch.mjs", import.meta.url));

const sessions = new Map();
const queues = new Map();
const shippers = new Map();
const inFlight = new Set();
let shipping = false;
let testHooks = null;
let releasingAll = null;

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

const sessionKey = (config, sessionId) =>
  `${config.observabilityEndpoint}\n${config.apiKey}\n${sessionId}`;

function logObs(config, message) {
  try {
    appendDaemonLog(config.dataDir, `[armorclaude-obs] ${message} pid=${process.pid}`);
  } catch {
    /* the log is best-effort */
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

async function rootStartTime(entry, config) {
  return config.dataDir ? claimRootStart(config.dataDir, entry.binding, entry.sessionId) : null;
}

function spoolSink(config, entry) {
  return {
    async write(batch) {
      let dropped;
      try {
        dropped = await writeSpoolBatch(config.dataDir, batch);
      } catch (err) {
        entry.sinkFailures += 1;
        logObs(config, `spool write failed, events stay in obs-journal: ${err?.message ?? err}`);
        throw err;
      }
      if (dropped) logObs(config, `spool over 8 MiB: dropped its ${dropped} oldest batch(es)`);
      for (const call of batchCalls(batch)) entry.written.add(call);
      if (shipping) afterSpoolWrite(config, entry);
    },
  };
}

function dataDirOptions(config, entry) {
  const leaseStore = obsLeaseStore(config.dataDir, config.observabilityEndpoint, config.apiKey);
  return entry ? { leaseStore, spanSink: spoolSink(config, entry) } : { leaseStore };
}

function runtimeOptionsFor(config, entry) {
  const sdkVersion = typeof armoriqSdk.VERSION === "string" ? armoriqSdk.VERSION : "unknown";
  const runtimeOptions = {
    backendEndpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    sdkVersion,
    options: { serviceName: config.observabilityProduct || "armorclaude" },
  };
  if (config.dataDir) Object.assign(runtimeOptions, dataDirOptions(config, entry));
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

async function initEntry(key, record, config) {
  const sessionId = record.input.session_id;
  const entry = {
    key,
    sessionId,
    lastEventAt: record.at,
    sinkFailures: 0,
    pending: [],
    written: new Set(),
  };
  entry.runtime = new ArmorIQTelemetryRuntime(runtimeOptionsFor(config, entry));
  entry.binding = entry.runtime.spoolBinding;
  const startTime = await rootStartTime(entry, config);
  entry.markerDir = startTime && config.dataDir;
  entry.session = new OtelSession(entry.runtime, {
    sessionId,
    agentId: config.agentId || null,
    userId: config.userId || null,
    root: { ...sessionRootIds(sessionId), startTime },
  });
  sessions.set(key, entry);
  await (shipping
    ? safeObsAsync(() => entry.session.refreshPolicy())
    : awaitHookLease(entry, config));
  await safeObsAsync(() => entry.session.beginRoot({ input: connectedInput(config) }));
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
  shipper.ready = replayBacklog(shipper);
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
  !releasingAll && (shipper.again || (round.more && round.settled > 0));

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
  if (releasingAll) return shipper.running;
  if (shipper.running) {
    shipper.again = true;
    return shipper.running;
  }
  shipper.running = shipRounds(shipper).finally(() => (shipper.running = null));
  return shipper.running;
}

export async function obsServeAsDaemon(config) {
  shipping = true;
  if (!config.dataDir) return;
  if (!isObsEnabled(config)) return void (await safeObsAsync(() => pruneJournal(config.dataDir)));
  await safeObsAsync(() => shipperFor(config).ready);
}

const shipDue = (shipper) => (Date.now() >= shipper.retryAt ? shipNow(shipper) : shipper.running);

function afterSpoolWrite(config, entry) {
  shipDue(shipperFor(config));
  if (entry.settleQueued || entry.pending.length === 0) return;
  entry.settleQueued = true;
  enqueue(entry.key, () => settleJournal(entry));
}

export function obsRetryBacklog() {
  const all = [...shippers.values()];
  return Promise.all([...all.map(shipDue), ...all.map(replayBacklog)]);
}

async function closeShippers() {
  const all = [...shippers.values()];
  shippers.clear();
  await Promise.all(
    all.map(async (shipper) => {
      await safeObsAsync(() => shipper.runtime.close());
      await shipper.running;
      clearTimeout(shipper.timer);
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

export function __resetObsForTests() {
  sessions.clear();
  queues.clear();
  shippers.clear();
  inFlight.clear();
  shipping = false;
  releasingAll = null;
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

async function obsCheck(entry, config, { input, output }) {
  const code = output?.[DECISION_CODE];
  await entry.session.recordPolicy(toolCall(input, config), {
    decision: classifyDecision(output),
    ...(code ? { policyReasonCode: code } : {}),
  });
}

async function obsReport(entry, config, { input }, outcome) {
  const call = toolCall(input, config);
  await entry.session.recordTool(
    { ...call, operation: { category: operationCategory(call.toolName) } },
    {
      outcome,
      result: redactSecrets(sanitizeParams(input.tool_response, config.sanitize)),
    }
  );
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
async function obsSlashCommand(entry, command) {
  await entry.session.recordOperation({
    category: "command",
    name: "command.execute",
    toolName: command.replace(/^\//, ""),
  });
}

function connectedInput(config) {
  return `ArmorClaude connected (${config.observabilityProduct || "armorclaude"})`;
}

async function obsEndSession(entry, config) {
  sessions.delete(entry.key);
  const endTime = new Date(entry.lastEventAt);
  await safeObsAsync(() => entry.session.close({ status: "ok", endTime }));
  if (config.dataDir) {
    await safeObsAsync(() =>
      markRootEnded(config.dataDir, entry.binding, entry.sessionId, endTime)
    );
  }
}

async function endedSince(entry) {
  const endedAt =
    entry.markerDir && (await rootEndedAt(entry.markerDir, entry.binding, entry.sessionId));
  return Boolean(endedAt) && endedAt.getTime() >= entry.lastEventAt;
}

async function releaseSession(entry) {
  if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
  await safeObsAsync(async () => {
    if (await endedSince(entry)) return entry.runtime.close();
    // unknown, not process_exit: the session may go on in another process, and
    // only SessionEnd knows how it ended.
    await entry.session.close({
      status: "ok",
      taskOutcome: "unknown",
      output: {},
      endTime: new Date(entry.lastEventAt),
    });
  });
  await settleJournal(entry);
}

async function settleJournal(entry) {
  entry.settleQueued = false;
  const settling = entry.pending.splice(0);
  if (settling.length === 0) return;
  await safeObsAsync(() => entry.runtime.forceFlush());
  const written = settledEvents(settling, entry);
  await Promise.all(written.map((item) => forgetEvent(item.file)));
  for (const item of settling) inFlight.delete(item.file);
  if (entry.pending.length === 0) entry.written.clear();
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
  await Promise.all([...sessions.values()].map(releaseSession));
  await closeShippers();
}

export function obsFlushAll() {
  releasingAll ??= releaseAll();
  return releasingAll;
}

export function obsReleaseIdle(maxIdleMs) {
  if (releasingAll) return Promise.resolve();
  const idleSince = Date.now() - maxIdleMs;
  const idle = [...sessions.values()].filter((entry) => entry.lastEventAt <= idleSince);
  return Promise.all(
    idle.map((entry) =>
      enqueue(entry.key, () => {
        if (sessions.get(entry.key) === entry && entry.lastEventAt <= idleSince) {
          return releaseSession(entry);
        }
      })
    )
  );
}

export function observeHook(event, input, output, config) {
  if (!isObsEnabled(config) || releasingAll) return Promise.resolve();
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId) return Promise.resolve();
  const record = { event, input, output, at: Date.now() };
  const key = sessionKey(config, sessionId);
  if (!shipping || !config.dataDir) return enqueueEvent(key, record, config, null);
  const shipper = shipperFor(config);
  const file = journalEntryPath(config.dataDir, shipper.binding, record.at);
  inFlight.add(file);
  const journaled = safeObsAsync(() => journalEvent(file, record)).then(
    (written) => written ?? void inFlight.delete(file)
  );
  return shipper.ready.then(() => enqueueEvent(key, record, config, journaled));
}

function enqueueEvent(key, record, config, journaled) {
  return enqueue(key, async () => {
    const file = (await journaled) ?? null;
    const entry = await recordEvent(key, record, config);
    await settleEvent(entry, record, file);
  });
}

function replayBacklog(shipper) {
  shipper.replaying ??= replayJournal(shipper).finally(() => (shipper.replaying = null));
  return shipper.replaying;
}

async function replayJournal({ config, binding }) {
  const backlog = await safeObsAsync(() => journalBacklog(config.dataDir, binding, inFlight));
  const replayed = new Set();
  for (const { file, record } of backlog ?? []) {
    const sessionId = record?.input?.session_id;
    if (typeof sessionId !== "string" || !sessionId) await forgetEvent(file);
    else {
      const key = sessionKey(config, sessionId);
      inFlight.add(file);
      enqueueEvent(key, record, config, file);
      replayed.add(key);
    }
  }
  for (const key of replayed) enqueue(key, () => settleKey(key));
}

const settleKey = (key) => sessions.has(key) && settleJournal(sessions.get(key));

async function settleEvent(entry, record, file) {
  if (!entry) return forgetSettled(file);
  if (file) entry.pending.push({ file, failures: entry.failuresBefore, call: eventCall(record) });
  if (record.event === "Stop") await releaseSession(entry);
  else if (record.event === "SessionEnd") await settleJournal(entry);
}

async function forgetSettled(file) {
  if (!file) return;
  await forgetEvent(file);
  inFlight.delete(file);
}

function entryFor(key, record, config) {
  const entry = sessions.get(key);
  if (entry) return entry;
  if (record.event === "Stop") return null;
  if (record.event === "UserPromptExpansion" && !expandedSlashCommand(record.input)) return null;
  return safeObsAsync(() => initEntry(key, record, config));
}

async function recordEvent(key, record, config) {
  const entry = await entryFor(key, record, config);
  if (!entry) return null;
  entry.lastEventAt = Math.max(entry.lastEventAt, record.at);
  entry.failuresBefore = entry.sinkFailures;
  await safeObsAsync(() => applyEvent(entry, record, config));
  return entry;
}

async function applyEvent(entry, record, config) {
  switch (record.event) {
    case "UserPromptExpansion": {
      const slash = expandedSlashCommand(record.input);
      if (slash) await obsSlashCommand(entry, slash);
      break;
    }
    case "PreToolUse":
      return obsCheck(entry, config, record);
    case "PostToolUse":
      return obsReport(entry, config, record, "success");
    case "PostToolUseFailure":
      return obsReport(entry, config, record, "error");
    case "SessionEnd":
      return obsEndSession(entry, config);
    default:
      break;
  }
}

export async function obsFlush(sessionId, config) {
  if (!isObsEnabled(config)) return;
  const entry = sessions.get(sessionKey(config, sessionId));
  if (entry) await releaseSession(entry);
}
