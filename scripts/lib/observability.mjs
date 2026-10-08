// Every process that records a session ships its own copy of the session's
// root span; the backend merges copies that share a span id.
import armoriqSdk from "@armoriq/sdk-dev";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sanitizeParams, redactSecrets } from "./common.mjs";
import { appendDaemonLog } from "./daemon-log.mjs";
import { DECISION_CODE } from "./hook-output.mjs";
import { LEASE_MISS_TTL_MS, obsLeaseMiss, obsLeaseStore } from "./obs-lease-store.mjs";
import {
  batchCalls,
  eventCall,
  forgetEvent,
  journalBacklog,
  journalEntryPath,
  journalEvent,
  JOURNAL_MAX_ENTRIES,
  journalName,
  pruneJournal,
  settledEvents,
} from "./obs-journal.mjs";
import {
  SPOOL_MAX_TRIES,
  shipRetryDelayMs,
  shipSpool,
  spooledJournal,
  writeSpoolBatch,
} from "./obs-spool.mjs";
import { claimRootStart, markRootEnded, rootEndedAt } from "./obs-root-marker.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;

const HOOK_LEASE_WAIT_MS = 1_500;
const REPLAY_SESSIONS = 16;
const LEASE_FETCHER = fileURLToPath(new URL("../obs-lease-fetch.mjs", import.meta.url));

const sessions = new Map();
const queues = new Map();
const shippers = new Map();
const inFlight = new Set();
const hookEntries = new Set();
let shipping = false;
let testHooks = null;
let releasingAll = null;
let journaledHere = false;

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

async function rootStartTime(entry, config, at) {
  return config.dataDir ? claimRootStart(config.dataDir, entry.binding, entry.sessionId, at) : null;
}

const coveredEntries = (entry, calls) =>
  entry.pending.filter((item) => calls.has(item.call)).map((item) => journalName(item.file));

function spoolSink(config, entry) {
  return {
    async write(batch) {
      const calls = new Set(batchCalls(batch));
      const journal = coveredEntries(entry, calls);
      let dropped;
      try {
        dropped = await writeSpoolBatch(config.dataDir, { ...batch, journal });
      } catch (err) {
        entry.sinkFailures += 1;
        logObs(config, `spool write failed, events stay in obs-journal: ${err?.message ?? err}`);
        throw err;
      }
      if (dropped) logObs(config, `spool over 8 MiB: dropped its ${dropped} oldest batch(es)`);
      for (const call of calls) entry.written.add(call);
      await forgetLanded(entry);
      if (shipping) afterSpoolWrite(config, entry);
    },
  };
}

const leaseStoreFor = (config) =>
  obsLeaseStore(config.dataDir, config.observabilityEndpoint, config.apiKey);

function dataDirOptions(config, entry, leaseStore = leaseStoreFor(config)) {
  return entry ? { leaseStore, spanSink: spoolSink(config, entry) } : { leaseStore };
}

function runtimeOptionsFor(config, entry, leaseStore) {
  const sdkVersion = typeof armoriqSdk.VERSION === "string" ? armoriqSdk.VERSION : "unknown";
  const runtimeOptions = {
    backendEndpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    sdkVersion,
    options: { serviceName: config.observabilityProduct || "armorclaude" },
  };
  if (config.dataDir) Object.assign(runtimeOptions, dataDirOptions(config, entry, leaseStore));
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
    records: [],
  };
  entry.runtime = new ArmorIQTelemetryRuntime(runtimeOptionsFor(config, entry));
  entry.binding = entry.runtime.spoolBinding;
  const startTime = await rootStartTime(entry, config, record.at);
  entry.markerDir = startTime && config.dataDir;
  entry.session = new OtelSession(entry.runtime, {
    sessionId,
    agentId: config.agentId || null,
    userId: config.userId || null,
    root: { ...sessionRootIds(sessionId), startTime },
  });
  sessions.set(key, entry);
  if (!shipping) hookEntries.add(entry);
  await openRoot(entry, config);
  return entry;
}

async function openRoot(entry, config) {
  await (shipping
    ? safeObsAsync(() => entry.session.refreshPolicy())
    : awaitHookLease(entry, config));
  if (shipping || hasLease(entry)) {
    await safeObsAsync(() => entry.session.beginRoot({ input: connectedInput(config) }));
  }
}

function shipperFor(config) {
  const key = `${config.dataDir}\n${config.observabilityEndpoint}\n${config.apiKey}`;
  let shipper = shippers.get(key);
  if (shipper) return shipper;
  shipper = {
    config,
    dataDir: config.dataDir,
    leaseTriedAt: 0,
    leaseAttempt: null,
    leaseHeld: true,
  };
  const store = leaseStoreFor(config);
  const leaseStore = {
    read: store.read,
    write: (lease) => (shipper.leaseStored = store.write(lease)),
  };
  const runtime = new ArmorIQTelemetryRuntime(runtimeOptionsFor(config, null, leaseStore));
  Object.assign(shipper, {
    binding: runtime.spoolBinding,
    runtime,
    skip: new Set(),
    running: null,
    again: false,
    failures: 0,
    retryAt: 0,
    timer: null,
  });
  shippers.set(key, shipper);
  shipper.ready = replayBacklog(shipper);
  shipper.ready.then(() => shipNow(shipper));
  return shipper;
}

async function shipRound(shipper) {
  const options = { skip: shipper.skip, ...(shipper.failures > 0 ? { limit: 1 } : {}) };
  const round = await safeObsAsync(() =>
    shipSpool(shipper.dataDir, shipper.binding, shipper.runtime, options)
  );
  logRound(shipper.config, round);
  return round;
}

function logRound(config, round) {
  if (round?.dropped) {
    logObs(
      config,
      `dropped ${round.dropped} spooled batch(es) after ${SPOOL_MAX_TRIES} failed exports`
    );
  }
  if (round?.rejected.length) {
    const reasons = [...new Set(round.rejected)].join(", ");
    logObs(
      config,
      `the backend rejected ${round.rejected.length} spooled batch(es), deleted: ${reasons}`
    );
  }
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
  const passAt = Date.now();
  const replayLeased = async (shipper) =>
    (await keyHoldsLease(shipper, passAt)) ? replayBacklog(shipper) : capJournal(shipper);
  return Promise.all([...all.map(shipDue), ...all.map(replayLeased)]);
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
  if (await safeObsAsync(() => miss?.recent())) return void (entry.leaseMissed = true);
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

export const __openSessionsForTests = () => sessions.size;

export function __resetObsForTests() {
  sessions.clear();
  queues.clear();
  shippers.clear();
  inFlight.clear();
  hookEntries.clear();
  shipping = false;
  releasingAll = null;
  journaledHere = false;
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
async function obsSlashCommand(entry, command, callId) {
  await entry.session.recordOperation({
    category: "command",
    name: "command.execute",
    toolName: command.replace(/^\//, ""),
    callId,
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

async function forgetLanded(entry) {
  const landed = entry.pending.filter((item) => entry.written.has(item.call));
  if (landed.length === 0) return;
  entry.pending = entry.pending.filter((item) => !landed.includes(item));
  await Promise.all(landed.map((item) => forgetSettled(item.file)));
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

const UNOBSERVED = { journaled: Promise.resolve(), recorded: Promise.resolve() };

function observe(event, input, output, config) {
  if (!isObsEnabled(config) || releasingAll) return UNOBSERVED;
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId) return UNOBSERVED;
  const record = { event, input, output, at: Date.now(), id: randomUUID() };
  const key = sessionKey(config, sessionId);
  if (!shipping || !config.dataDir) {
    return { journaled: Promise.resolve(), recorded: enqueueEvent(key, record, config, null) };
  }
  const shipper = shipperFor(config);
  const file = journalEntryPath(config.dataDir, shipper.binding, record.at);
  inFlight.add(file);
  const journaled = journalOrLog(config, file, record);
  const recorded = shipper.ready.then(() => enqueueEvent(key, record, config, journaled));
  return { journaled, recorded };
}

async function parkedWithoutLease(key, record, config, file) {
  const shipper = !sessions.has(key) && leasedShipper(config);
  if (!shipper || (await keyHoldsLease(shipper, record.replayedAt))) return false;
  const { session_id: sessionId } = record.input;
  await claimRootStart(config.dataDir, shipper.binding, sessionId, record.at);
  await keepForReplay(shipper.binding, record, file, config);
  return true;
}

export const observeHook = (event, input, output, config) =>
  observe(event, input, output, config).recorded;

export const journalHook = (event, input, output, config) =>
  observe(event, input, output, config).journaled.then(() => undefined);

function enqueueEvent(key, record, config, journaled) {
  return enqueue(key, async () => {
    const file = (await journaled) ?? null;
    if (await parkedWithoutLease(key, record, config, file)) return;
    const entry = await recordEvent(key, record, config);
    await settleEvent(entry, record, file, config);
  });
}

function replayBacklog(shipper) {
  shipper.replaying ??= replayJournal(shipper).finally(() => (shipper.replaying = null));
  return shipper.replaying;
}

function replaySlots(free) {
  const waiting = [];
  return {
    take: () => (free > 0 ? Promise.resolve(free--) : new Promise((r) => waiting.push(r))),
    give: () => (waiting.length > 0 ? waiting.shift()() : free++),
  };
}

function backlogBySession(config, backlog) {
  const bySession = new Map();
  for (const { file, record } of backlog) {
    const sessionId = record?.input?.session_id;
    if (typeof sessionId !== "string" || !sessionId) forgetEvent(file);
    else {
      const key = sessionKey(config, sessionId);
      bySession.set(key, [...(bySession.get(key) ?? []), { file, record }]);
    }
  }
  return bySession;
}

function logJournalDrops(config, journal) {
  const dropped = journal?.dropped;
  if (dropped) logObs(config, `dropped ${dropped} journaled event(s) past ${JOURNAL_MAX_ENTRIES}`);
}

async function capJournal({ config }) {
  logJournalDrops(
    config,
    await safeObsAsync(() => pruneJournal(config.dataDir, Date.now(), inFlight))
  );
}

async function adoptJournal({ config, binding }) {
  const spooled = () => spooledJournal(config.dataDir, binding);
  const journal = await safeObsAsync(() =>
    journalBacklog(config.dataDir, binding, inFlight, Date.now(), spooled)
  );
  logJournalDrops(config, journal);
  return journal?.backlog ?? [];
}

async function replayJournal(shipper) {
  const replayedAt = Date.now();
  const backlog = await adoptJournal(shipper);
  const slots = replaySlots(REPLAY_SESSIONS);
  for (const [key, events] of backlogBySession(shipper.config, backlog)) {
    for (const { file } of events) inFlight.add(file);
    enqueue(key, slots.take);
    for (const { file, record } of events) {
      enqueueEvent(key, { ...record, replayedAt }, shipper.config, file);
    }
    enqueue(key, () => releaseReplayed(key).finally(slots.give));
  }
}

const releaseReplayed = async (key) => sessions.has(key) && releaseSession(sessions.get(key));

async function settleEvent(entry, record, file, config) {
  if (!entry) return forgetSettled(file);
  if (entry.parked) return keepForReplay(entry.binding, record, file, config);
  if (file) entry.pending.push({ file, failures: entry.failuresBefore, call: eventCall(record) });
  if (!shipping) entry.records.push(record);
  if (record.event === "Stop") await releaseSession(entry);
  else if (record.event === "SessionEnd") await settleJournal(entry);
}

async function forgetSettled(file) {
  if (!file) return;
  await forgetEvent(file);
  inFlight.delete(file);
}

async function journalOrLog(config, file, record) {
  try {
    return await journalEvent(file, record);
  } catch (err) {
    inFlight.delete(file);
    logObs(config, `journal write failed, the event is lost on a crash: ${err?.message ?? err}`);
    return null;
  }
}

async function keepForReplay(binding, record, file, config) {
  if (file) return void inFlight.delete(file);
  if (!config.dataDir) return;
  journaledHere = true;
  await journalOrLog(config, journalEntryPath(config.dataDir, binding, record.at), record);
}

const PARKING = "no policy lease for this key: new events wait in obs-journal";

const hasLease = (entry) => !entry.leaseMissed && holdsLease(entry);

const holdsLease = ({ runtime }) => runtime.currentCeilingSnapshot().authoritative === true;

const leaseRetryDue = (shipper, replayedAt) =>
  replayedAt
    ? shipper.leaseTriedAt <= replayedAt
    : Date.now() - shipper.leaseTriedAt > LEASE_MISS_TTL_MS;

async function keyHoldsLease(shipper, replayedAt) {
  if (!holdsLease(shipper) && leaseRetryDue(shipper, replayedAt)) {
    shipper.leaseTriedAt = Date.now();
    shipper.leaseAttempt = safeObsAsync(() => shipper.runtime.refreshPolicy());
  }
  await shipper.leaseAttempt;
  await safeObsAsync(() => shipper.leaseStored);
  const held = holdsLease(shipper);
  if (held !== shipper.leaseHeld) logLease(shipper, held);
  return held;
}

function logLease(shipper, held) {
  if (held || shipper.leaseHeld) {
    logObs(shipper.config, held ? "policy lease back, parked events replay" : PARKING);
  }
  shipper.leaseHeld = held;
}

const leasedShipper = (config) => shipping && config.dataDir && shipperFor(config);

async function mayRecord(entry, record, config) {
  if (entry.parked && !record.replayedAt) return false;
  const shipper = leasedShipper(config);
  if (shipper && !holdsLease(entry) && (await keyHoldsLease(shipper, record.replayedAt))) {
    await safeObsAsync(() => entry.session.refreshPolicy());
  }
  entry.parked = !hasLease(entry);
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
  entry.failuresBefore = entry.sinkFailures;
  if (!(await mayRecord(entry, record, config))) return entry;
  entry.lastEventAt = Math.max(entry.lastEventAt, record.at);
  await safeObsAsync(() => applyEvent(entry, record, config));
  return entry;
}

async function applyEvent(entry, record, config) {
  switch (record.event) {
    case "UserPromptExpansion": {
      const slash = expandedSlashCommand(record.input);
      if (slash) await obsSlashCommand(entry, slash, record.id);
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

async function journalLostRecords(config) {
  for (const entry of hookEntries) {
    if (entry.sinkFailures > 0) {
      for (const record of entry.records) await keepForReplay(entry.binding, record, null, config);
    }
  }
  hookEntries.clear();
}

export async function obsFlush(sessionId, config) {
  if (!isObsEnabled(config)) return;
  const entry = sessions.get(sessionKey(config, sessionId));
  if (entry) await releaseSession(entry);
  await journalLostRecords(config);
  if (journaledHere && !shipping) await capJournal({ config });
  journaledHere = false;
}
