/** O_APPEND writes are atomic only up to PIPE_BUF (~4 KB), so appendLine caps rows at 4000 bytes or rows tear. */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, open, readFile, rename, stat, unlink } from "node:fs/promises";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  ftruncateSync,
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
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  ensurePrivateDirSync,
  tightenDirFilesOnce,
  writePrivateFile,
} from "./fs-store.mjs";
import sizeLimits from "./audit-size-limits.json" with { type: "json" };

const MAX_LINE_BYTES = 4000;
const DEFAULT_ROTATE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ROTATE_AGE_MS = 60 * 60 * 1000;
const ROW_BUDGET_BYTES =
  MAX_LINE_BYTES -
  Buffer.byteLength(
    JSON.stringify({ _seq: Number.MAX_SAFE_INTEGER, _enqueuedAt: Number.MAX_SAFE_INTEGER })
  );

export const loginTag = (backend, apiKey) =>
  createHash("sha256").update(`${backend}\n${apiKey}`).digest("hex").slice(0, 16);

export const LOGIN_TAG = /^[0-9a-f]{16}$/;

const rowBytes = (row) => Buffer.byteLength(JSON.stringify(row), "utf8");

function truncateField(row, field) {
  const json = JSON.stringify(row[field]);
  const originalBytes = Buffer.byteLength(json, "utf8");
  let keep = json.length;
  for (;;) {
    const next = {
      ...row,
      [field]: { truncated: true, originalBytes, preview: json.slice(0, keep) },
    };
    const excess = rowBytes(next) - ROW_BUDGET_BYTES;
    if (excess <= 0 || keep === 0) return next;
    keep = Math.max(0, keep - excess);
  }
}

const fieldBytes = (row, field) => Buffer.byteLength(JSON.stringify(row[field] ?? null), "utf8");

export function fitAuditRow(row) {
  const largestFirst = ["input", "output"].sort((a, b) => fieldBytes(row, b) - fieldBytes(row, a));
  let fitted = row;
  for (const field of largestFirst) {
    if (rowBytes(fitted) <= ROW_BUDGET_BYTES) return fitted;
    const shrunk = truncateField(fitted, field);
    if (rowBytes(shrunk) < rowBytes(fitted)) fitted = shrunk;
  }
  const bytes = rowBytes(fitted);
  if (bytes > ROW_BUDGET_BYTES) {
    throw new Error(`${row.tool} row is ${bytes} bytes after truncation, cap is ${MAX_LINE_BYTES}`);
  }
  return fitted;
}

export function createAuditWal(opts) {
  const dir = path.join(opts.dataDir, "audit", opts.login);
  const currentPath = path.join(dir, "current.jsonl");
  const offsetPath = path.join(dir, "shipped.offset");
  const archiveDir = path.join(dir, "archive");
  const rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;
  const rotateAgeMs = opts.rotateAgeMs ?? DEFAULT_ROTATE_AGE_MS;

  let ensured = false;
  async function ensureDirs() {
    if (ensured) return;
    await ensurePrivateDir(opts.dataDir);
    await ensurePrivateDir(path.dirname(dir));
    await ensurePrivateDir(dir);
    await ensurePrivateDir(archiveDir);
    await tightenDirFilesOnce(dir);
    await tightenDirFilesOnce(archiveDir);
    ensured = true;
  }

  let seqCounter = 0;

  async function appendLine(row) {
    const enriched = {
      ...row,
      _seq: ++seqCounter,
      _enqueuedAt: Date.now(),
    };
    await ensureDirs();
    const json = JSON.stringify(enriched);
    if (Buffer.byteLength(json, "utf8") > MAX_LINE_BYTES) {
      throw new Error(
        `audit row too large (${Buffer.byteLength(json, "utf8")} bytes); cap is ${MAX_LINE_BYTES}`
      );
    }
    await appendFile(currentPath, `${json}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  }

  async function readShippedOffset() {
    try {
      const raw = await readFile(offsetPath, "utf8");
      const n = Number.parseInt(raw.trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (err) {
      if (err && err.code === "ENOENT") return 0;
      throw err;
    }
  }

  async function writeShippedOffset(offset) {
    await ensureDirs();
    await writePrivateFile(offsetPath, String(offset));
  }

  async function readBatch(maxRows = 100) {
    await ensureDirs();
    if (!existsSync(currentPath)) return { rows: [], endOffset: 0 };

    const offset = await readShippedOffset();
    const fh = await open(currentPath, "r");
    try {
      const st = await fh.stat();
      if (offset >= st.size) return { rows: [], endOffset: offset };
      const length = st.size - offset;
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, offset);

      const rows = [];
      let pos = 0;
      let lineEnd;
      while (rows.length < maxRows && (lineEnd = buf.indexOf(0x0a, pos)) !== -1) {
        const line = buf.slice(pos, lineEnd).toString("utf8");
        if (line.length > 0) {
          try {
            rows.push(JSON.parse(line));
          } catch (err) {
            process.stderr.write(
              `[audit-wal] skipping malformed line at offset ${offset + pos}: ${err?.message ?? err}\n`
            );
          }
        }
        pos = lineEnd + 1;
      }

      rows.sort(compareForOrder);
      const stripped = rows.map((row) => {
        const rest = { ...row };
        delete rest._seq;
        delete rest._enqueuedAt;
        return rest;
      });
      return { rows: stripped, endOffset: offset + pos };
    } finally {
      await fh.close();
    }
  }

  function compareForOrder(a, b) {
    const aSeq = typeof a?._seq === "number" ? a._seq : null;
    const bSeq = typeof b?._seq === "number" ? b._seq : null;
    if (aSeq !== null && bSeq !== null) return aSeq - bSeq;
    const aTs = typeof a?._enqueuedAt === "number" ? a._enqueuedAt : 0;
    const bTs = typeof b?._enqueuedAt === "number" ? b._enqueuedAt : 0;
    if (aTs !== bTs) return aTs - bTs;
    const aEx = typeof a?.executed_at === "string" ? a.executed_at : "";
    const bEx = typeof b?.executed_at === "string" ? b.executed_at : "";
    if (aEx < bEx) return -1;
    if (aEx > bEx) return 1;
    return 0;
  }

  async function advanceOffset(newOffset) {
    if (typeof newOffset !== "number" || newOffset < 0) {
      throw new Error(`invalid offset: ${newOffset}`);
    }
    await writeShippedOffset(newOffset);
    await rotateIfNeeded();
  }

  async function rotateIfNeeded() {
    if (!existsSync(currentPath)) return;
    const st = await stat(currentPath);
    const offset = await readShippedOffset();
    const fullyShipped = offset >= st.size;
    const tooBig = st.size >= rotateBytes;
    const tooOld = Date.now() - st.mtimeMs >= rotateAgeMs;
    if (!fullyShipped) return;
    if (!tooBig && !tooOld) return;

    await ensureDirs();
    const ts = new Date().toISOString().slice(0, 10);
    let seq = 1;
    let archivePath;
    do {
      archivePath = path.join(archiveDir, `${ts}-${String(seq).padStart(3, "0")}.jsonl`);
      seq += 1;
    } while (existsSync(archivePath));
    await rename(currentPath, archivePath);
    await writeShippedOffset(0);
  }

  async function pruneArchive(keep = 5) {
    if (!existsSync(archiveDir)) return [];
    const entries = readdirSync(archiveDir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => ({ name: file, mtime: statSync(path.join(archiveDir, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    const deleted = [];
    for (const entry of entries.slice(keep)) {
      try {
        await unlink(path.join(archiveDir, entry.name));
        deleted.push(entry.name);
      } catch (err) {
        process.stderr.write(
          `[audit-wal] failed to delete ${entry.name}: ${err?.message ?? err}\n`
        );
      }
    }
    return deleted;
  }

  async function pendingBytes() {
    if (!existsSync(currentPath)) return 0;
    const st = await stat(currentPath);
    const offset = await readShippedOffset();
    return Math.max(0, st.size - offset);
  }

  return {
    appendLine,
    readBatch,
    advanceOffset,
    rotateIfNeeded,
    pruneArchive,
    pendingBytes,
    readShippedOffset,
    _paths: { currentPath, offsetPath, archiveDir },
  };
}

const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
export const OUTBOX_SIZE_LIMITS = validateLimits({ ...sizeLimits, maxRowBytes: 4000 });

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

export function fitOutboxRow(row, limits = OUTBOX_SIZE_LIMITS) {
  const fitted = copy(row);
  for (const field of limits.shrinkOrder ?? OUTBOX_SIZE_LIMITS.shrinkOrder) {
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
    if (snapshot) Object.assign(snapshot, { dev: info.dev, ino: info.ino });
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

export function createOutbox(opts) {
  if (!LOGIN_TAG.test(opts.login)) throw new Error("Invalid audit login tag");
  const dir = path.join(opts.dataDir, "audit", opts.login);
  const legacyOffsetPath = path.join(dir, "shipped.offset");
  const offsetPath = path.join(dir, "outbox-state.json");
  const deadPath = path.join(dir, "dead-letters.jsonl");
  const archiveDir = path.join(dir, "outbox-archive");
  const limits = validateLimits({ ...OUTBOX_SIZE_LIMITS, ...opts.sizeLimits });
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
        durableAppend(path.join(dir, state.active), JSON.stringify(entry.row) + "\n");
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

  function settle(state, entry) {
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
    delete state.attempts[entry.id];
    delete state.identities[entry.id];
  }

  function replayDead(state) {
    const buffer = readFrom(deadPath, state.deadOffset);
    let pos = 0;
    for (let end; (end = buffer.indexOf(10, pos)) !== -1; pos = end + 1) {
      const dead = JSON.parse(buffer.subarray(pos, end).toString("utf8"));
      if (dead.entry?.active === state.active) settle(state, dead.entry);
      state.deadCount += 1;
    }
    state.deadOffset += pos;
    return pos > 0;
  }

  function deadLetter(state, row, reason, attempts, entry) {
    opts.beforeCommit?.("deadLetter");
    durableAppend(
      deadPath,
      JSON.stringify({
        row,
        reason,
        attempts,
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
      if (replayDead(state) && write) persist(state);
      return fn(state);
    });
  }

  function entries(state) {
    const buffer = readFrom(path.join(dir, state.active), state.offset);
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
      delete row._seq;
      delete row._enqueuedAt;
      if (state.identities[id]) row.client_row_id = state.identities[id];
      pending.push({
        id,
        row,
        malformed,
        startOffset,
        login: state.binding,
        attempts: 0,
        nextAttemptAt: 0,
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
      opts.beforeCommit?.("append");
      const fitted = fitOutboxRow(row, limits);
      if (!fitted) {
        deadLetter(state, row, "oversize", 0);
        return;
      }
      // Persist the binding before the journal can acquire its first captured row.
      durableAppend(path.join(dir, state.active), JSON.stringify(fitted) + "\n");
    });
  }

  return {
    appendLine,
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
            state.paused || !sameLogin(state.binding, resolveLogin(state.binding))
              ? pendingEntries(state).length
              : releasedRows().rows.filter((entry) => !entry.login).length,
          olderVersion: releasedRows().rows.filter((entry) => !entry.login).length,
          deadLetters: state.deadCount + (!existsSync(offsetPath) ? releasedRows().dead.length : 0),
        }),
        { write: false }
      ),
    restoreLogin: (revision) =>
      transaction((state) => {
        if (!sameLogin(state.binding, bound)) return;
        if (revision !== undefined && revision === state.revision) return;
        state.paused = false;
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
