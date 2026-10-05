// Every process that records a session ships its own copy of the session's
// root span; the backend merges copies that share a span id.
import armoriqSdk from "@armoriq/sdk-dev";
import { createHash } from "node:crypto";
import { sanitizeParams, redactSecrets } from "./common.mjs";
import { appendDaemonLog } from "./daemon-log.mjs";
import { LEASE_MISS_TTL_MS, obsLeaseMiss, obsLeaseStore } from "./obs-lease-store.mjs";
import {
  forgetEvent,
  journalBacklog,
  journalEntryPath,
  journalEvent,
  pruneJournal,
} from "./obs-journal.mjs";
import { shipRetryDelayMs, shipSpool, writeSpoolBatch } from "./obs-spool.mjs";
import { claimRootStart, markRootEnded, rootEndedAt } from "./obs-root-marker.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;

const HOOK_LEASE_WAIT_MS = 1_500;

const sessions = new Map();
const queues = new Map();
const shippers = new Map();
const inFlight = new Set();
const hookEntries = new Set();
const FLUSHES = new Set(["Stop", "SessionEnd"]);
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

async function rootStartTime(sessionId, config) {
  return config.dataDir ? claimRootStart(config.dataDir, sessionId) : null;
}

function spoolSink(config, entry) {
  return {
    async write(batch) {
      try {
        await writeSpoolBatch(config.dataDir, batch);
      } catch (err) {
        entry.sinkFailures += 1;
        logObs(config, `spool write failed, events stay in obs-journal: ${err?.message ?? err}`);
        throw err;
      }
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
    records: [],
  };
  entry.runtime = new ArmorIQTelemetryRuntime(runtimeOptionsFor(config, entry));
  const startTime = await rootStartTime(sessionId, config);
  entry.markerDir = startTime && config.dataDir;
  entry.session = new OtelSession(entry.runtime, {
    sessionId,
    agentId: config.agentId || null,
    userId: config.userId || null,
    root: { ...sessionRootIds(sessionId), startTime },
  });
  sessions.set(key, entry);
  if (!shipping) hookEntries.add(entry);
  await (shipping
    ? safeObsAsync(() => entry.session.refreshPolicy())
    : awaitHookLease(entry, config));
  entry.leaseTriedAt = Date.now();
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

function shipRound(shipper) {
  const options = { skip: shipper.skip, ...(shipper.failures > 0 ? { limit: 1 } : {}) };
  return safeObsAsync(() => shipSpool(shipper.dataDir, shipper.binding, shipper.runtime, options));
}

function retryLater(shipper) {
  shipper.failures += 1;
  const delay = shipRetryDelayMs(shipper.failures);
  shipper.retryAt = Date.now() + delay;
  clearTimeout(shipper.timer);
  shipper.timer = setTimeout(() => shipNow(shipper), delay);
  shipper.timer.unref();
}

const nothingShipped = (round) => !round || (round.failed && round.settled === 0);
const moreDue = (shipper, round) =>
  shipper.again || (!releasingAll && (round.more || round.failed));

async function shipRounds(shipper) {
  for (;;) {
    shipper.again = false;
    const round = await shipRound(shipper);
    if (nothingShipped(round)) return retryLater(shipper);
    shipper.failures = 0;
    if (!moreDue(shipper, round)) return;
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
  await within(
    safeObsAsync(() => entry.session.refreshPolicy()),
    HOOK_LEASE_WAIT_MS
  );
  const leased = entry.runtime.currentCeilingSnapshot().authoritative;
  if (!leased) await safeObsAsync(() => miss?.record());
}

export function __resetObsForTests() {
  sessions.clear();
  queues.clear();
  shippers.clear();
  inFlight.clear();
  hookEntries.clear();
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
  const reason = output?.hookSpecificOutput?.permissionDecisionReason || undefined;
  await entry.session.recordPolicy(toolCall(input, config), {
    decision: classifyDecision(output),
    ...(reason ? { policyReasonCode: reason } : {}),
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
    await safeObsAsync(() => markRootEnded(config.dataDir, entry.sessionId, endTime));
  }
}

async function endedSince(entry) {
  const endedAt = entry.markerDir && (await rootEndedAt(entry.markerDir, entry.sessionId));
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
  const written = settling.filter((item) => item.failures === entry.sinkFailures);
  await Promise.all(written.map((item) => forgetEvent(item.file)));
  for (const item of settling) inFlight.delete(item.file);
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
    await settleEvent(entry, record, file, config);
  });
}

function replayBacklog(shipper) {
  shipper.replaying ??= replayJournal(shipper).finally(() => (shipper.replaying = null));
  return shipper.replaying;
}

async function replayJournal({ config, binding }) {
  const replayedAt = Date.now();
  const backlog = await safeObsAsync(() => journalBacklog(config.dataDir, binding, inFlight));
  const replayed = new Set();
  for (const { file, record } of backlog ?? []) {
    const sessionId = record?.input?.session_id;
    if (typeof sessionId !== "string" || !sessionId) await forgetEvent(file);
    else {
      const key = sessionKey(config, sessionId);
      inFlight.add(file);
      enqueueEvent(key, { ...record, replayedAt }, config, file);
      replayed.add(key);
    }
  }
  for (const key of replayed) enqueue(key, () => settleKey(key));
}

const settleKey = (key) => sessions.has(key) && settleJournal(sessions.get(key));

async function settleEvent(entry, record, file, config) {
  if (!entry) return forgetSettled(file);
  if (entry.parked) return keepForReplay(entry, record, file, config);
  if (file) entry.pending.push({ file, failures: entry.failuresBefore });
  if (!shipping) entry.records.push(record);
  if (FLUSHES.has(record.event)) await settleJournal(entry);
}

async function forgetSettled(file) {
  if (!file) return;
  await forgetEvent(file);
  inFlight.delete(file);
}

async function keepForReplay(entry, record, file, config) {
  if (file) return void inFlight.delete(file);
  if (!config.dataDir) return;
  const target = journalEntryPath(config.dataDir, entry.runtime.spoolBinding, record.at);
  await safeObsAsync(() => journalEvent(target, record));
}

const holdsLease = (entry) => entry.runtime.currentCeilingSnapshot().authoritative === true;

const leaseRetryDue = (entry, { replayedAt }) =>
  replayedAt
    ? entry.leaseTriedAt <= replayedAt
    : Date.now() - entry.leaseTriedAt > LEASE_MISS_TTL_MS;

async function mayRecord(entry, record) {
  if (entry.parked && !record.replayedAt) return false;
  if (shipping && !holdsLease(entry) && leaseRetryDue(entry, record)) {
    entry.leaseTriedAt = Date.now();
    await safeObsAsync(() => entry.session.refreshPolicy());
  }
  entry.parked = !holdsLease(entry);
  return !entry.parked;
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
  if (await mayRecord(entry, record)) await safeObsAsync(() => applyEvent(entry, record, config));
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
    case "Stop":
      return entry.session.flush("ok");
    case "SessionEnd":
      return obsEndSession(entry, config);
    default:
      break;
  }
}

async function journalLostRecords(config) {
  for (const entry of hookEntries) {
    if (entry.sinkFailures > 0) {
      for (const record of entry.records) await keepForReplay(entry, record, null, config);
    }
  }
  hookEntries.clear();
}

export async function obsFlush(sessionId, config) {
  if (!isObsEnabled(config)) return;
  const entry = sessions.get(sessionKey(config, sessionId));
  if (entry) await releaseSession(entry);
  await journalLostRecords(config);
}
