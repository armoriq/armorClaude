import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ensurePrivateDirSync, PRIVATE_FILE_MODE } from "./fs-store.mjs";
import { sdkModule } from "./sdk.mjs";
import { CLIENT_EVENTS, clientEvent } from "./client-events.mjs";
import sizeLimits from "./audit-size-limits.json" with { type: "json" };
import { RUNS_CONTRACT } from "./runs.mjs";

export const LOGIN_TAG = /^[0-9a-f]{16}$/;
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const loginTag = (backend, apiKey) =>
  createHash("sha256").update(`${backend}\n${apiKey}`).digest("hex").slice(0, 16);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const copy = (value) => JSON.parse(JSON.stringify(value));
const identified = (login) =>
  typeof login?.backend === "string" &&
  !!login.backend &&
  typeof login?.keyId === "string" &&
  !!login.keyId;
const sameLogin = (a, b) =>
  identified(a) &&
  identified(b) &&
  a.backend === b.backend &&
  a.keyId === b.keyId &&
  b.available !== false;
const queues = new Map();
// The owner keeps armorClaude at its released 4000 byte row budget, below conmap-auto's wire cap.
export const AUDIT_SIZE_LIMITS = validateLimits({ ...sizeLimits, maxRowBytes: 4000 });

function validateLimits(limits) {
  if (
    !limits ||
    !["maxRowBytes", "maxBatchBytes", "maxBatchRows"].every(
      (key) => Number.isSafeInteger(limits[key]) && limits[key] > 0
    ) ||
    limits.maxBatchBytes < limits.maxRowBytes + bytes({ rows: [] }) ||
    JSON.stringify(limits.shrinkOrder) !== '["input","output"]' ||
    JSON.stringify(limits.truncationMarker) !== '{"truncated":true}'
  )
    throw new Error("Invalid audit sizeLimits contract");
  return copy(limits);
}

export function fitAuditRow(row, limits = AUDIT_SIZE_LIMITS) {
  const fitted = copy(row);
  for (const field of limits.shrinkOrder ?? AUDIT_SIZE_LIMITS.shrinkOrder) {
    if (bytes(fitted) <= limits.maxRowBytes) break;
    if (Object.hasOwn(fitted, field)) fitted[field] = copy(limits.truncationMarker);
  }
  return bytes(fitted) <= limits.maxRowBytes ? fitted : null;
}

function syncDir(dir) {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function privateDir(dir) {
  const existed = existsSync(dir);
  if (!existed) privateDir(path.dirname(dir));
  ensurePrivateDirSync(dir);
  if (!existed) {
    syncDir(dir);
    syncDir(path.dirname(dir));
  }
}

function removeOwner(location, token) {
  try {
    unlinkSync(path.join(location, token));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    rmdirSync(location);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

function durableReplace(file, value, serialize = true) {
  const tmp = `${file}.tmp.${randomUUID()}`;
  const fd = openSync(tmp, "wx", PRIVATE_FILE_MODE);
  try {
    writeFileSync(fd, serialize ? JSON.stringify(value) : value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
    syncDir(path.dirname(file));
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function locked(dir, fn) {
  const lock = path.join(dir, ".storage-lock");
  const previous = queues.get(lock) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      privateDir(dir);
      const token = `${process.pid}-${randomUUID()}`;
      const candidate = path.join(dir, `.candidate-${token}`);
      mkdirSync(candidate, { mode: 0o700 });
      writeFileSync(path.join(candidate, token), String(process.pid), { mode: PRIVATE_FILE_MODE });
      const until = Date.now() + 10_000;
      try {
        for (;;) {
          try {
            renameSync(candidate, lock);
            break;
          } catch (error) {
            if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
            // Removing only the observed generation cannot erase a successor's lock.
            let owners;
            try {
              owners = readdirSync(lock);
            } catch (err) {
              if (err.code === "ENOENT") continue;
              throw err;
            }
            for (const owner of owners) {
              const pid = Number(owner.split("-")[0]);
              if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) {
                try {
                  unlinkSync(path.join(lock, owner));
                } catch (err) {
                  if (err.code !== "ENOENT") throw err;
                }
              }
            }
            try {
              rmdirSync(lock);
            } catch (err) {
              if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(err.code)) throw err;
            }
            if (Date.now() >= until)
              throw new Error("Audit storage lock is held by another process");
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        return fn();
      } finally {
        for (const location of [lock, candidate]) {
          removeOwner(location, token);
        }
      }
    });
  queues.set(lock, next);
  try {
    return await next;
  } finally {
    if (queues.get(lock) === next) queues.delete(lock);
  }
}

function readFrom(file, offset = 0, snapshot) {
  if (!existsSync(file)) return Buffer.alloc(0);
  const fd = openSync(file, "r");
  try {
    const info = fstatSync(fd);
    if (snapshot)
      Object.assign(snapshot, { dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs });
    const size = info.size;
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, offset + read);
      if (!count) break;
      read += count;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function durableAppend(file, text) {
  const existed = existsSync(file);
  const fd = openSync(file, "a+", PRIVATE_FILE_MODE);
  try {
    const size = fstatSync(fd).size;
    if (size) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 10) {
        const previous = readFrom(file);
        const complete = previous.lastIndexOf(10) + 1;
        // Preserve a torn tail before repair, so recovery never erases collected bytes.
        durableReplace(
          `${file}.incomplete.${randomUUID()}`,
          previous.subarray(complete).toString("utf8")
        );
        ftruncateSync(fd, complete);
      }
    }
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!existed) syncDir(path.dirname(file));
}

export function createAuditWal(opts) {
  if (!LOGIN_TAG.test(opts.login)) throw new Error("Invalid audit login tag");
  const stream = opts.stream ?? "audit";
  if (!CLIENT_EVENTS.queues.includes(stream)) throw new Error("Invalid outbox stream");
  const health = stream === "health";
  const runs = stream === "runs";
  const idField = health ? "event_id" : "client_row_id";
  const batchField = health ? "events" : runs ? "reports" : "rows";
  const identity = (row) => (runs ? JSON.stringify([row.run_id, row.report_seq]) : row[idField]);
  const settledField = runs ? "reportsSettled" : "eventsSettled";
  const dir = path.join(opts.dataDir, stream, opts.login);
  const legacyOffsetPath = path.join(dir, "shipped.offset");
  const offsetPath = path.join(dir, "outbox-state.json");
  const deadPath = path.join(dir, "dead-letters.jsonl");
  const archiveDir = path.join(dir, "outbox-archive");
  const receiptDir = path.join(dir, "outbox-receipts");
  const receiptPath = (id) => {
    const hash = createHash("sha256").update(String(id)).digest("hex");
    return path.join(receiptDir, hash.slice(0, 2), hash.slice(2));
  };
  const limits = validateLimits({ ...AUDIT_SIZE_LIMITS, ...opts.sizeLimits });
  if (health) limits.maxBatchRows = Math.min(limits.maxBatchRows, CLIENT_EVENTS.maxBatchEvents);
  if (runs) {
    limits.maxBatchRows = Math.min(limits.maxBatchRows, RUNS_CONTRACT.limits.maxBatchReports);
    limits.maxBatchBytes = Math.min(limits.maxBatchBytes, RUNS_CONTRACT.limits.maxBatchBytes);
  }
  const clock = opts.clock ?? { now: () => Date.now(), random: () => Math.random() };
  const timing = {
    baseMs: 1000,
    maxMs: 300_000,
    lockTtlMs: 120_000,
    authProbeMs: 120_000,
    healthProbeMs: 30_000,
    holdProbeMs: 300_000,
    maxHoldProbeMs: 3_600_000,
    ...opts.timing,
  };
  const bound = identified(opts.binding)
    ? { backend: opts.binding.backend, keyId: opts.binding.keyId }
    : null;

  function readState() {
    if (existsSync(offsetPath)) {
      const state = JSON.parse(readFileSync(offsetPath, "utf8"));
      if (bound && state.binding && !sameLogin(state.binding, bound))
        throw new Error("Audit login binding cannot change");
      return state;
    }
    const released = releasedRows();
    if (released.binding) {
      if (bound && !sameLogin(released.binding, bound))
        throw new Error("Audit login binding cannot change");
    }
    return {
      version: 2,
      binding: released.binding ?? bound,
      active: "outbox-current.jsonl",
      offset: 0,
      settled: [],
      attempts: {},
      identities: {},
      deadOffset: 0,
      deadCount: 0,
      paused: released.paused ?? false,
      lease: null,
      revision: null,
    };
  }

  function releasedRows() {
    const raw = existsSync(legacyOffsetPath)
      ? JSON.parse(readFileSync(legacyOffsetPath, "utf8"))
      : 0;
    const previous = raw?.version === 1 && typeof raw === "object" ? raw : null;
    if (!previous && (!Number.isSafeInteger(raw) || raw < 0))
      throw new Error("Invalid legacy audit offset");
    const active = previous?.active ?? "current.jsonl";
    const file = path.join(dir, active);
    const segment = {};
    const buffer = readFrom(file, 0, segment);
    const offset = previous?.offset ?? raw;
    const rows = [];
    let pos = offset <= buffer.length ? offset : 0;
    for (let end; (end = buffer.indexOf(10, pos)) !== -1; pos = end + 1) {
      const id = `${active}:${pos}`;
      if (end === pos || previous?.settled?.includes(id)) continue;
      const row = JSON.parse(buffer.subarray(pos, end).toString("utf8"));
      const enqueuedAt = Number.isFinite(row._enqueuedAt) ? row._enqueuedAt : segment.birthtimeMs;
      delete row._seq;
      delete row._enqueuedAt;
      if (previous?.identities?.[id]) row.client_row_id = previous.identities[id];
      const source = `${segment.dev}:${segment.ino}:${pos}:${createHash("sha256").update(buffer.subarray(pos, end)).digest("hex")}`;
      rows.push({
        id: source,
        row,
        login: previous?.binding ?? null,
        attempts: 0,
        nextAttemptAt: 0,
        enqueuedAt,
      });
    }
    return {
      rows,
      binding: previous?.binding,
      dead: previous?.dead ?? [],
      paused: previous?.paused,
    };
  }

  function importReleased(state, released) {
    if (!sameLogin(state.binding, released.binding)) return;
    state.releasedSeen ??= {};
    const pendingIds = new Set(entries(state).map(({ row }) => row.client_row_id));
    for (const entry of released.rows) {
      const source =
        entry.row.client_row_id && ROW_ID.test(entry.row.client_row_id)
          ? entry.row.client_row_id
          : entry.id;
      if (state.releasedSeen[source]) continue;
      if (!ROW_ID.test(entry.row.client_row_id ?? "")) {
        state.releasedIdentities ??= {};
        entry.row.client_row_id = state.releasedIdentities[source] ??= randomUUID();
        persist(state);
      }
      if (!pendingIds.has(entry.row.client_row_id))
        durableAppend(
          path.join(dir, state.active),
          JSON.stringify({ ...entry.row, _enqueuedAt: entry.enqueuedAt }) + "\n"
        );
      state.releasedSeen[source] = true;
    }
    if (!state.releasedDeadImported) {
      const buffer = readFrom(deadPath);
      const imported = new Set(
        buffer
          .subarray(0, buffer.lastIndexOf(10) + 1)
          .toString("utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line).releasedId)
      );
      for (const dead of released.dead) {
        const releasedId = createHash("sha256").update(JSON.stringify(dead)).digest("hex");
        if (!imported.has(releasedId))
          durableAppend(deadPath, JSON.stringify({ ...dead, releasedId }) + "\n");
      }
      state.releasedDeadImported = true;
    }
  }

  function persist(state) {
    durableReplace(offsetPath, state);
  }

  function settle(state, entry, writeReceipt = true) {
    const start = entry.startOffset ?? Number(entry.id.slice(entry.id.lastIndexOf(":") + 1));
    state.settled.push([start, entry.endOffset]);
    state.settled.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of state.settled) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    while (merged.length && merged[0][0] <= state.offset) {
      state.offset = Math.max(state.offset, merged.shift()[1]);
    }
    state.settled = merged;
    if ((health || runs) && entry.row) rememberSettled(state, entry.row, writeReceipt);
    delete state.attempts[entry.id];
    delete state.identities[entry.id];
  }

  function rememberSettled(state, row, writeReceipt = true) {
    const recent = new Set(state[settledField] ?? []);
    recent.delete(identity(row));
    recent.add(identity(row));
    const ids = [...recent];
    if (writeReceipt) {
      // A durable receipt keeps an evicted id from being captured twice.
      for (const id of [...ids.slice(0, -512), identity(row)]) {
        const file = receiptPath(id);
        if (!existsSync(file)) {
          privateDir(path.dirname(file));
          durableReplace(file, id);
        }
      }
    }
    state[settledField] = ids.slice(-512);
  }

  function replayDead(state, writeReceipt = true) {
    const buffer = readFrom(deadPath, state.deadOffset);
    let pos = 0;
    for (let end; (end = buffer.indexOf(10, pos)) !== -1; pos = end + 1) {
      const dead = JSON.parse(buffer.subarray(pos, end).toString("utf8"));
      if (dead.entry?.active === state.active)
        settle(state, { ...dead.entry, row: dead.row }, writeReceipt);
      else if ((health || runs) && dead.row) rememberSettled(state, dead.row, writeReceipt);
      if (dead.reason !== "malformed")
        stageHealth(
          state,
          "dead_letter",
          1,
          dead.terminalReason ?? "rejected",
          undefined,
          dead.occurred_at
        );
      state.deadCount += 1;
    }
    state.deadOffset += pos;
    return pos > 0;
  }

  function deadLetter(state, row, reason, attempts, entry, terminalReason = reason) {
    opts.beforeCommit?.("deadLetter");
    durableAppend(
      deadPath,
      JSON.stringify({
        row,
        reason,
        attempts,
        terminalReason,
        occurred_at: new Date(clock.now()).toISOString(),
        ...(entry
          ? { entry: { active: state.active, id: entry.id, endOffset: entry.endOffset } }
          : {}),
      }) + "\n"
    );
    opts.beforeCommit?.("deadLetterWritten");
    replayDead(state);
    persist(state);
  }

  function transaction(fn, { write = true } = {}) {
    privateDir(opts.dataDir);
    privateDir(path.dirname(dir));
    return locked(dir, () => {
      const initialized = existsSync(offsetPath);
      const state = readState();
      if (write) {
        if (!initialized) privateDir(archiveDir);
        const released = releasedRows();
        const before = JSON.stringify(state);
        importReleased(state, released);
        if (!initialized || JSON.stringify(state) !== before) persist(state);
      }
      if (write)
        for (const file of [offsetPath, deadPath, path.join(dir, state.active)]) {
          if (existsSync(file) && (statSync(file).mode & 0o077) !== 0)
            chmodSync(file, PRIVATE_FILE_MODE);
        }
      if (replayDead(state, write) && write) persist(state);
      return fn(state);
    });
  }

  function entries(state) {
    const activeFile = path.join(dir, state.active);
    const buffer = readFrom(activeFile, state.offset);
    const enqueuedAt = existsSync(activeFile) ? statSync(activeFile).birthtimeMs : clock.now();
    const pending = [];
    let pos = 0;
    let rangeIndex = 0;
    for (let end; (end = buffer.indexOf(10, pos)) !== -1; pos = end + 1) {
      const startOffset = state.offset + pos;
      while (state.settled[rangeIndex]?.[1] <= startOffset) rangeIndex += 1;
      if (state.settled[rangeIndex]?.[0] <= startOffset || end === pos) continue;
      const id = `${state.active}:${startOffset}`;
      let row;
      let malformed = false;
      try {
        row = JSON.parse(buffer.subarray(pos, end).toString("utf8"));
        if (!row || typeof row !== "object" || Array.isArray(row))
          throw new Error("Invalid audit row");
      } catch {
        row = { raw: buffer.subarray(pos, end).toString("utf8") };
        malformed = true;
      }
      const queuedAt = Number.isFinite(row._enqueuedAt) ? row._enqueuedAt : enqueuedAt;
      delete row._seq;
      delete row._enqueuedAt;
      if (state.identities[id]) row[idField] = state.identities[id];
      pending.push({
        id,
        row,
        malformed,
        startOffset,
        login: state.binding,
        attempts: 0,
        nextAttemptAt: 0,
        enqueuedAt: queuedAt,
        ...state.attempts[id],
        endOffset: state.offset + end + 1,
      });
    }
    return pending;
  }

  function pendingEntries(state) {
    const released = releasedRows().rows.filter((entry) => {
      const source =
        entry.row.client_row_id && ROW_ID.test(entry.row.client_row_id)
          ? entry.row.client_row_id
          : entry.id;
      return !state.releasedSeen?.[source];
    });
    return [...released, ...entries(state)];
  }

  function stageHealth(
    state,
    type,
    count,
    reason,
    extra,
    occurredAt = new Date(clock.now()).toISOString()
  ) {
    if (health) return;
    state.healthEvents ??= [];
    // The conmap-auto event contract has one time, so merging different times would erase information.
    const open =
      type === "dead_letter"
        ? state.healthEvents.find(
            (event) =>
              event.type === type &&
              event.reason_code === reason &&
              event.occurred_at === occurredAt &&
              !extra &&
              !state.healthInFlight?.includes(event.event_id)
          )
        : undefined;
    if (open) {
      const room = Math.min(count, CLIENT_EVENTS.maxCount - open.count);
      open.count += room;
      count -= room;
    }
    while (count > 0) {
      const part = Math.min(count, CLIENT_EVENTS.maxCount);
      state.healthEvents.push(
        clientEvent(type, stream, part, reason, Date.parse(occurredAt), extra)
      );
      count -= part;
    }
  }

  async function appendLine(original, { fallback = false } = {}) {
    let row = copy(original);
    if (fallback) {
      row = {
        client_row_id: row.client_row_id,
        tool: "unknown",
        action: "unknown",
        input: {},
        executed_at: row.executed_at,
        decision_code: row.decision_code,
        status: "blocked",
        ...(typeof row.session_id === "string" ? { session_id: row.session_id } : {}),
      };
    }
    return transaction((state) => {
      if (
        (health || runs) &&
        ((state[settledField] ?? []).includes(identity(row)) ||
          existsSync(receiptPath(identity(row))) ||
          entries(state).some((entry) => identity(entry.row) === identity(row)))
      )
        return;
      opts.beforeCommit?.("append");
      const fitted = fitAuditRow(row, limits);
      if (!fitted) {
        deadLetter(state, row, "oversize", 0);
        persist(state);
        return;
      }
      // Persist the binding before the journal can acquire its first captured row.
      durableAppend(
        path.join(dir, state.active),
        JSON.stringify({ ...fitted, _enqueuedAt: clock.now() }) + "\n"
      );
    });
  }

  function rotate(state) {
    const file = path.join(dir, state.active);
    if (!existsSync(file) || state.offset < statSync(file).size) return;
    const info = statSync(file);
    if (
      info.size < (opts.rotateBytes ?? 10 * 1024 * 1024) &&
      clock.now() - info.mtimeMs < (opts.rotateAgeMs ?? 60 * 60 * 1000)
    )
      return;
    privateDir(archiveDir);
    const archived = path.join(
      archiveDir,
      `${new Date(clock.now()).toISOString().slice(0, 10)}-${randomUUID()}.jsonl`
    );
    linkSync(file, archived);
    syncDir(archiveDir);
    const next = `outbox-current-${randomUUID()}.jsonl`;
    durableAppend(path.join(dir, next), "");
    // The pointer and acknowledgements commit together, so rotation cannot replay another segment's offset.
    state.active = next;
    state.offset = 0;
    state.settled = [];
    state.attempts = {};
    state.identities = {};
    persist(state);
    unlinkSync(file);
    syncDir(dir);
  }

  function parseResults(body, batch) {
    if (!body || typeof body !== "object") return null;
    const results = new Map();
    if (Object.hasOwn(body, "results")) {
      if (!Array.isArray(body.results)) return null;
      const ids = new Set(batch.map(({ row }) => identity(row)));
      for (const result of body.results) {
        if (
          !result ||
          !ids.has(identity(result)) ||
          results.has(identity(result)) ||
          !(
            runs ? ["accepted", "stale", "duplicate", "rejected"] : CLIENT_EVENTS.outcomes
          ).includes(result.outcome) ||
          (result.error !== undefined && typeof result.error !== "string")
        )
          return null;
        results.set(identity(result), result);
      }
      return new Map(batch.map((entry) => [entry.id, results.get(identity(entry.row))]));
    }
    if (health || runs || !Array.isArray(body.failures)) return null;
    for (const failure of body.failures) {
      if (
        !failure ||
        !Number.isInteger(failure.index) ||
        failure.index < 0 ||
        failure.index >= batch.length ||
        results.has(batch[failure.index].id) ||
        typeof failure.error !== "string"
      )
        return null;
      results.set(batch[failure.index].id, { outcome: "retryable", error: failure.error });
    }
    return new Map(
      batch.map((entry) => [entry.id, results.get(entry.id) ?? { outcome: "accepted" }])
    );
  }

  function delay(attempts, header) {
    const cap = Math.min(timing.maxMs, timing.baseMs * 2 ** Math.min(32, attempts - 1));
    let retryAfter = 0;
    if (typeof header === "string" && header.trim()) {
      const seconds = Number(header);
      retryAfter = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - clock.now();
    }
    return Math.max(
      cap / 2 + (clock.random() * cap) / 2,
      Number.isFinite(retryAfter) ? retryAfter : 0
    );
  }

  async function authenticationSucceeded(login) {
    return transaction((state) => {
      if (!state.paused || !sameLogin(state.binding, login)) return;
      state.paused = false;
      delete state.nextProbeAt;
      persist(state);
    });
  }

  async function drain(send, { resolveLogin = () => null, probe } = {}) {
    const login = await resolveLogin(bound);
    const generation = randomUUID();
    let batchRows = limits.maxBatchRows;
    const selection = await transaction((state) => {
      if (
        !sameLogin(state.binding, login) ||
        (state.endpointPaused && state.probeAt > clock.now()) ||
        (state.lease && state.lease.expiresAt > clock.now())
      )
        return null;
      batchRows = Math.min(batchRows, state.batchRows ?? batchRows);
      const pending = entries(state).filter((entry) => entry.nextAttemptAt <= clock.now());
      if (state.paused) {
        if (!probe) return null;
        if (state.nextProbeAt === undefined) {
          state.nextProbeAt = clock.now() + timing.authProbeMs;
          persist(state);
        }
        if (state.nextProbeAt > clock.now()) return null;
        state.nextProbeAt = clock.now() + timing.authProbeMs;
        state.lease = { generation, expiresAt: clock.now() + timing.lockTtlMs };
        persist(state);
        return { probe: true };
      }
      if (!pending.length) return null;
      state.lease = { generation, expiresAt: clock.now() + timing.lockTtlMs };
      for (const entry of pending) {
        if (
          runs ||
          entry.malformed ||
          (typeof entry.row[idField] === "string" && ROW_ID.test(entry.row[idField]))
        )
          continue;
        // Persist generated ids before sending so a crash cannot replay a row under a new identity.
        const id = randomUUID();
        state.identities ??= {};
        state.identities[entry.id] = id;
        entry.row[idField] = id;
      }
      persist(state);
      return { pending };
    });
    if (!selection) return;
    const owns = (state) =>
      state.lease?.generation === generation && state.lease.expiresAt > clock.now();
    async function deliver(batch) {
      const current = await resolveLogin(bound);
      const allowed = await transaction(
        (state) =>
          owns(state) &&
          !state.paused &&
          (!state.endpointPaused || state.probeAt <= clock.now()) &&
          sameLogin(state.binding, current)
      );
      if (!allowed) return;
      let reply;
      let networkError;
      try {
        reply = await send({ login: copy(bound), rows: batch.map(({ row }) => copy(row)) });
      } catch (error) {
        networkError = String(error);
        reply = { status: 0, body: null };
      }
      const hasResults =
        !!reply?.body && typeof reply.body === "object" && Object.hasOwn(reply.body, "results");
      const results =
        hasResults || (reply?.status >= 200 && reply.status < 300)
          ? parseResults(reply.body, batch)
          : null;
      const split = !hasResults && [400, 422].includes(reply?.status) && batch.length > 1;
      if (split) {
        const middle = Math.floor(batch.length / 2);
        await deliver(batch.slice(0, middle));
        await deliver(batch.slice(middle));
        return;
      }
      const resize = await transaction((state) => {
        if (!owns(state)) return [];
        const hold =
          reply?.hold ||
          (reply?.status === 403 && reply.body?.error === "org_required"
            ? "org_required"
            : !hasResults &&
                reply?.status >= 400 &&
                reply.status < 500 &&
                ![400, 401, 403, 408, 409, 413, 422, 429].includes(reply.status)
              ? `http_${reply.status}`
              : state.held === "org_required" && !results
                ? state.held
                : !reply?.status && state.endpointPaused
                  ? (state.held ?? "endpoint_unavailable")
                  : null);
        state.holdRetries = hold === "org_required" ? (state.holdRetries ?? 0) + 1 : 0;
        state.endpointPaused = Boolean(hold);
        state.held = hold;
        state.probeAt = hold
          ? clock.now() +
            (hold === "org_required"
              ? Math.min(
                  timing.maxHoldProbeMs,
                  timing.holdProbeMs * 2 ** Math.min(state.holdRetries - 1, 20)
                )
              : timing.healthProbeMs)
          : 0;
        if (hold) {
          state.paused = false;
          delete state.nextProbeAt;
          state.stallReason = null;
          persist(state);
          return [];
        }
        if (reply?.status === 401 || (reply?.status === 403 && !hasResults)) {
          state.paused = true;
          state.stallReason = "auth_paused";
          state.nextProbeAt = clock.now() + timing.authProbeMs;
          persist(state);
          return [];
        }
        const decisions = new Map();
        for (const entry of batch) {
          const prior = state.attempts[entry.id] ?? { attempts: 0 };
          const result = results?.get(entry.id);
          const transient =
            !reply?.status ||
            [408, 429].includes(reply.status) ||
            reply.status >= 500 ||
            (reply.status === 409 && reply.body?.error === "request_in_progress") ||
            result?.outcome === "retryable" ||
            (hasResults && (!results || !result)) ||
            (reply.status >= 200 && reply.status < 300);
          const attempts =
            (prior.attempts ?? 0) + (result?.outcome === "rejected" || !transient ? 1 : 0);
          const failures = (prior.failures ?? prior.attempts ?? 0) + 1;
          const reason =
            result?.error ||
            networkError ||
            (result ? result.outcome : `HTTP ${reply?.status ?? 0}: unreadable or missing outcome`);
          const ack = (
            runs ? ["accepted", "duplicate", "stale"] : ["accepted", "duplicate"]
          ).includes(result?.outcome);
          const dead =
            result?.outcome === "rejected" ||
            attempts >= 10 ||
            (!hasResults && batch.length === 1 && [400, 422].includes(reply?.status));
          const terminalReason =
            result?.outcome === "rejected" || (!hasResults && [400, 422].includes(reply?.status))
              ? "rejected"
              : "attempts_exhausted";
          state.attempts[entry.id] = {
            enqueuedAt: entry.enqueuedAt,
            attempts,
            failures,
            delivered: ack,
            lastError: reason,
            terminalReason,
            nextAttemptAt:
              ack || dead ? 0 : clock.now() + delay(failures, reply?.headers?.["retry-after"]),
          };
          if (ack) decisions.set(entry.id, "ack");
          else if (dead) {
            decisions.set(entry.id, "deadLetter");
          }
        }
        state.stallReason =
          decisions.size === batch.length
            ? null
            : reply?.status === 429
              ? "rate_limited"
              : reply?.status >= 500
                ? "server_error"
                : "backend_unreachable";
        persist(state);
        if ([...decisions.values()].includes("ack")) opts.beforeCommit?.("ack");
        for (const entry of batch) {
          const decision = decisions.get(entry.id);
          if (!decision) continue;
          if (decision === "deadLetter")
            deadLetter(
              state,
              entry.row,
              state.attempts[entry.id].lastError,
              state.attempts[entry.id].attempts,
              entry,
              state.attempts[entry.id].terminalReason
            );
          else settle(state, entry);
        }
        const oversized = batch.filter(
          (entry) =>
            batch.length > 1 &&
            !decisions.has(entry.id) &&
            results?.get(entry.id)?.outcome === "retryable" &&
            results?.get(entry.id)?.error === "batch_oversize"
        );
        if (oversized.length) {
          batchRows = Math.min(batchRows, Math.max(1, Math.floor(batch.length / 2)));
          state.batchRows = batchRows;
        }
        if (batch.every((entry) => decisions.get(entry.id) === "ack")) {
          delete state.batchRows;
          batchRows = limits.maxBatchRows;
        }
        persist(state);
        return reply?.headers?.["retry-after"] ? [] : oversized;
      });
      if (resize.length) {
        const middle = Math.max(1, Math.floor(resize.length / 2));
        await deliver(resize.slice(0, middle));
        if (middle < resize.length) await deliver(resize.slice(middle));
      }
    }
    try {
      let selected = selection.pending;
      if (selection.probe) {
        let reply;
        try {
          reply = await probe({ login: copy(bound) });
        } catch {
          return;
        }
        const current = await resolveLogin(bound);
        selected = await transaction((state) => {
          if (!owns(state) || !sameLogin(state.binding, current)) return null;
          if (!(reply?.status >= 200 && reply.status < 300)) return null;
          state.paused = false;
          delete state.nextProbeAt;
          persist(state);
          return entries(state).filter((entry) => entry.nextAttemptAt <= clock.now());
        });
        if (!selected) return;
      }
      let batch = [];
      for (const entry of selected) {
        if (entry.malformed || entry.delivered || entry.attempts >= 10) {
          await transaction((state) => {
            if (!owns(state)) return;
            if (entry.delivered) {
              opts.beforeCommit?.("ack");
              settle(state, entry);
            } else
              deadLetter(
                state,
                entry.row,
                entry.malformed ? "malformed" : entry.lastError,
                entry.attempts,
                entry,
                entry.malformed ? "malformed" : (entry.terminalReason ?? "attempts_exhausted")
              );
            persist(state);
          });
          continue;
        }
        if (
          batch.length &&
          (batch.length >= batchRows ||
            batch.some(({ row }) => identity(row) && identity(row) === identity(entry.row)) ||
            bytes({ [batchField]: [...batch, entry].map(({ row }) => row) }) > limits.maxBatchBytes)
        ) {
          await deliver(batch);
          batch = [];
        }
        batch.push(entry);
      }
      if (batch.length) await deliver(batch);
    } finally {
      await transaction((state) => {
        if (state.lease?.generation !== generation) return;
        state.lease = null;
        persist(state);
        rotate(state);
      });
    }
  }

  async function reportHealth(stallReason, { resolveLogin = () => null } = {}) {
    if (health) return;
    const reports = await transaction((state) => {
      const before = JSON.stringify(state);
      const pending = entries(state);
      const reason = state.held
        ? null
        : state.paused
          ? "auth_paused"
          : !sameLogin(state.binding, resolveLogin(state.binding))
            ? "undeliverable_login"
            : (stallReason ?? state.stallReason);
      const lastStallAt = state.lastStallAt ?? -Infinity;
      if (pending.length && reason && clock.now() - lastStallAt >= 3_600_000) {
        stageHealth(state, "queue_stalled", pending.length, reason, {
          oldest_pending_seconds: Math.max(
            0,
            Math.floor(
              (clock.now() -
                pending.reduce(
                  (oldest, entry) => Math.min(oldest, entry.enqueuedAt),
                  clock.now()
                )) /
                1000
            )
          ),
        });
        state.lastStallAt = clock.now();
      }
      const inFlight = (state.healthEvents ?? []).map(({ event_id }) => event_id);
      if (inFlight.length || state.healthInFlight?.length) state.healthInFlight = inFlight;
      if (JSON.stringify(state) !== before) persist(state);
      return { binding: state.binding, events: copy(state.healthEvents ?? []) };
    });
    if (!reports.events.length) return;
    if (!identified(reports.binding)) throw new Error("Health report has no login binding");
    const spool = createAuditWal({ ...opts, binding: reports.binding, stream: "health" });
    for (const event of reports.events) {
      // Keep the source receipt until the health append commits, so a crash can only cause a duplicate.
      await spool.appendLine(event);
      await transaction((state) => {
        // Copied events are frozen, so concurrent dead letters keep their own receipt.
        state.healthEvents = (state.healthEvents ?? []).filter(
          (staged) => staged.event_id !== event.event_id
        );
        state.healthInFlight = (state.healthInFlight ?? []).filter((id) => id !== event.event_id);
        persist(state);
      });
    }
  }

  return {
    appendLine,
    drain,
    reportHealth,
    readBinding: () => transaction((state) => state.binding, { write: false }),
    authenticationSucceeded,
    readPending: () => transaction((state) => pendingEntries(state), { write: false }),
    readDeadLetters: () =>
      transaction(
        () => {
          if (!existsSync(offsetPath)) return copy(releasedRows().dead);
          const buffer = readFrom(deadPath);
          return buffer
            .subarray(0, buffer.lastIndexOf(10) + 1)
            .toString("utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const { row, reason, attempts } = JSON.parse(line);
              return { row, reason, attempts };
            });
        },
        { write: false }
      ),
    status: (resolveLogin = () => null) =>
      transaction(
        (state) => ({
          undeliverable:
            state.paused ||
            state.endpointPaused ||
            !sameLogin(state.binding, resolveLogin(state.binding))
              ? pendingEntries(state).length
              : releasedRows().rows.filter((entry) => !entry.login).length,
          olderVersion: releasedRows().rows.filter((entry) => !entry.login).length,
          deadLetters: state.deadCount + (!existsSync(offsetPath) ? releasedRows().dead.length : 0),
          held: state.held ?? (state.endpointPaused ? "endpoint_unavailable" : null),
          authPaused: Boolean(state.paused),
          pending: entries(state).length,
          paused: Boolean(
            state.endpointPaused ||
            state.paused ||
            !sameLogin(state.binding, resolveLogin(state.binding))
          ),
        }),
        { write: false }
      ),
    restoreLogin: (revision) =>
      transaction((state) => {
        if (!sameLogin(state.binding, bound)) return;
        if (revision !== undefined && revision === state.revision) return;
        state.paused = false;
        state.endpointPaused = false;
        state.held = null;
        state.holdRetries = 0;
        state.probeAt = 0;
        delete state.nextProbeAt;
        state.revision = revision ?? null;
        persist(state);
      }),
    pruneArchive: (keep = 5) =>
      transaction(
        () => {
          const names = readdirSync(archiveDir)
            .filter((name) => name.endsWith(".jsonl"))
            .sort(
              (a, b) =>
                statSync(path.join(archiveDir, b)).mtimeMs -
                statSync(path.join(archiveDir, a)).mtimeMs
            );
          const older = names.slice(keep);
          if (!older.length) return [];
          const retained = path.join(archiveDir, "retained");
          privateDir(retained);
          for (const name of older)
            renameSync(path.join(archiveDir, name), path.join(retained, `${randomUUID()}-${name}`));
          syncDir(retained);
          syncDir(archiveDir);
          return older;
        },
        { write: false }
      ),
    pendingBytes: () =>
      transaction(
        (state) => {
          const file = path.join(dir, state.active);
          return existsSync(file)
            ? Math.max(
                0,
                statSync(file).size -
                  state.offset -
                  state.settled.reduce((total, [start, end]) => total + end - start, 0)
              )
            : 0;
        },
        { write: false }
      ),
    _paths: {
      get currentPath() {
        return path.join(dir, readState().active);
      },
      offsetPath,
      legacyOffsetPath,
      deadPath,
      archiveDir,
    },
  };
}

export async function recordCaptureFailure(dataDir, code, executedAt = new Date().toISOString()) {
  await locked(dataDir, () => {
    const fd = openSync(path.join(dataDir, "audit-capture-failures.jsonl"), "a", PRIVATE_FILE_MODE);
    try {
      writeFileSync(fd, JSON.stringify({ code, executed_at: executedAt }) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDir(dataDir);
  });
}

export async function auditStatus(dataDir, resolveLogin = () => null) {
  const root = path.join(dataDir, "audit");
  const total = { undeliverable: 0, olderVersion: 0, deadLetters: 0, captureFailures: 0 };
  if (existsSync(root))
    for (const name of readdirSync(root)) {
      if (LOGIN_TAG.test(name)) {
        const wal = createAuditWal({ dataDir, login: name });
        const status = await wal.status(resolveLogin);
        total.undeliverable += status.undeliverable;
        total.olderVersion += status.olderVersion;
        total.deadLetters += status.deadLetters;
        if (status.held) total.holds = [...new Set([...(total.holds ?? []), status.held])];
      } else if (name === "current.jsonl") {
        const buffer = readFileSync(path.join(root, name));
        const offsetFile = path.join(root, "shipped.offset");
        const offset = existsSync(offsetFile) ? Number(readFileSync(offsetFile, "utf8").trim()) : 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error("Invalid legacy audit offset");
        const olderVersion = buffer
          .subarray(offset <= buffer.length ? offset : 0)
          .toString("utf8")
          .split("\n")
          .filter(Boolean).length;
        total.undeliverable += olderVersion;
        total.olderVersion += olderVersion;
      }
    }
  const failures = path.join(dataDir, "audit-capture-failures.jsonl");
  if (existsSync(failures))
    total.captureFailures = readFileSync(failures, "utf8").split("\n").filter(Boolean).length;
  return total;
}

export async function healthStatus(dataDir, resolveLogin = () => null) {
  const root = path.join(dataDir, "health");
  const total = { pending: 0, paused: false, deadLetters: 0, undeliverable: 0 };
  if (!existsSync(root)) return total;
  for (const login of readdirSync(root).filter((name) => LOGIN_TAG.test(name))) {
    const status = await createAuditWal({ dataDir, login, stream: "health" }).status(resolveLogin);
    total.pending += status.pending;
    total.paused ||= status.paused;
    total.deadLetters += status.deadLetters;
    total.undeliverable += status.undeliverable;
    if (status.held) total.holds = [...new Set([...(total.holds ?? []), status.held])];
  }
  return total;
}

export async function recordAuthenticationSuccess(config) {
  if (!config?.dataDir || !config.backendEndpoint || !config.apiKey || config.signedOut) return;
  const keyId = loginTag(config.backendEndpoint, config.apiKey);
  const binding = { backend: config.backendEndpoint, keyId };
  for (const stream of ["audit", "health", ...(config.runReportingEnabled ? ["runs"] : [])]) {
    try {
      const statePath = path.join(config.dataDir, stream, keyId, "outbox-state.json");
      if (!existsSync(statePath) || !JSON.parse(readFileSync(statePath, "utf8")).paused) continue;
      await createAuditWal({
        dataDir: config.dataDir,
        login: keyId,
        binding,
        stream,
      }).authenticationSucceeded(binding);
    } catch {
      process.stderr.write(`[armorclaude] ${stream} authentication pause could not be cleared.\n`);
    }
  }
}

export async function runsStatus(dataDir, resolveLogin = () => null) {
  const root = path.join(dataDir, "runs");
  const total = { pending: 0, paused: false, deadLetters: 0, undeliverable: 0 };
  if (!existsSync(root)) return total;
  for (const login of readdirSync(root).filter((name) => LOGIN_TAG.test(name))) {
    const status = await createAuditWal({ dataDir, login, stream: "runs" }).status(resolveLogin);
    total.pending += status.pending;
    total.paused ||= status.paused;
    total.deadLetters += status.deadLetters;
    total.undeliverable += status.undeliverable;
    if (status.held) total.holds = [...new Set([...(total.holds ?? []), status.held])];
  }
  return total;
}

export function auditLoginConfig(binding, base = {}) {
  if (!identified(binding)) return null;
  if (base.signedOut && base.backendEndpoint === binding.backend) return null;
  const profile = sdkModule("credentials").loadLoginContext({
    backend: binding.backend,
    product: "armorclaude",
  })?.profile;
  const local =
    base.armoriqEnv === "local" &&
    base.backendEndpoint === binding.backend &&
    !base.signedOut &&
    base.apiKey === "ak_test_localmock000000000000";
  const apiKey = profile?.apiKey || (local ? base.apiKey : "");
  if (!apiKey || loginTag(binding.backend, apiKey) !== binding.keyId) return null;
  return { ...base, apiKey, backendEndpoint: binding.backend, loggedInAt: profile?.loggedInAt };
}
