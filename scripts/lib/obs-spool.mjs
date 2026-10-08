import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, PRIVATE_FILE_MODE, writePrivateFile } from "./fs-store.mjs";
import { forgetJournaled } from "./obs-journal.mjs";
import {
  claimable,
  claimRecord,
  dropExpired,
  listRecords,
  processGone,
  readClaimed,
  removeRecord,
} from "./obs-records.mjs";

const SPOOL_MAX_BYTES = 8 * 1024 * 1024;
export const SPOOL_MAX_TRIES = 8;
const SHIP_LIMIT = 64;
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;
const KEPT = new Set(["failed", "unsupported"]);
const BATCH_FAULTS = new Set(["export_failed"]);

const FIELDS = /^\d+-(\d+)-([0-9a-f]{64})-([0-9a-f-]{36})-(\d+)-(\d+)-(\d+)\.json$/;
const BINDING = /^[0-9a-f]{64}$/;

const spoolDir = (dataDir) => path.join(dataDir, "obs-spool");

function spoolFields(ready) {
  const match = FIELDS.exec(ready);
  if (!match) return null;
  const [, bytes, binding, id, tries, fails, dueAt] = match;
  const counts = { tries: Number(tries), fails: Number(fails), dueAt: Number(dueAt) };
  return { bytes: Number(bytes), binding, id, ...counts };
}

const batchName = ({ at, bytes, binding, id, tries, fails, dueAt }) =>
  `${at}-${bytes}-${binding}-${id}-${tries}-${fails}-${dueAt}.json`;

async function pruneSpool(dir) {
  const live = await dropExpired(dir, await listRecords(dir, spoolFields), Date.now());
  let kept = 0;
  const over = live
    .sort((a, b) => b.at - a.at)
    .filter((entry) => {
      if (entry.kind !== "ready") return false;
      kept += entry.bytes;
      return kept > SPOOL_MAX_BYTES;
    });
  await Promise.all(over.map((entry) => removeRecord(dir, entry.name)));
  return over.length;
}

export async function spooledJournal(dataDir, binding) {
  const dir = spoolDir(dataDir);
  const placed = (await listRecords(dir, spoolFields)).filter(
    (entry) => entry.binding === binding && entry.kind !== "draft"
  );
  const batches = await Promise.all(
    placed.map((entry) => readClaimed(dir, { claimed: entry.name }))
  );
  return new Set(batches.flatMap(journalOf));
}

const journalOf = (batch) => (Array.isArray(batch?.journal) ? batch.journal : []);

export async function writeSpoolBatch(dataDir, batch) {
  if (!BINDING.test(batch?.binding)) throw new Error("a spooled batch needs its runtime's binding");
  const dir = spoolDir(dataDir);
  const text = JSON.stringify(batch);
  const bytes = Buffer.byteLength(text);
  const id = randomUUID();
  const fresh = { tries: 0, fails: 0, dueAt: 0 };
  const name = batchName({ at: Date.now(), bytes, binding: batch.binding, id, ...fresh });
  await ensurePrivateDir(dir);
  await writePrivateFile(path.join(dir, name), text);
  return pruneSpool(dir);
}

export function shipRetryDelayMs(failures) {
  return Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS);
}

async function settle(dir, entry, result, { skip, answered }) {
  const fault = BATCH_FAULTS.has(result.reason);
  const fails = entry.fails + (fault ? 1 : 0);
  const tries = entry.tries + (fault && answered ? 1 : 0);
  if (!KEPT.has(result.status) || tries >= SPOOL_MAX_TRIES) {
    await removeRecord(dir, entry.claimed);
    return { settled: !KEPT.has(result.status), dropped: KEPT.has(result.status), dueAt: Infinity };
  }
  if (result.status === "unsupported") skip.add(entry.ready);
  const dueAt = fault ? Date.now() + shipRetryDelayMs(fails) : entry.dueAt;
  const next = path.join(dir, batchName({ ...entry, tries, fails, dueAt }));
  await rename(path.join(dir, entry.claimed), next).catch(() => undefined);
  return { settled: false, dropped: false, dueAt: fault ? dueAt : Infinity };
}

const failedBefore = (entry) => entry.dueAt > 0;
const freshFirst = (a, b) => failedBefore(a) - failedBefore(b) || a.fails - b.fails || a.at - b.at;
const notTheBatch = (entry, result) =>
  result.status === "failed" && (!failedBefore(entry) || !BATCH_FAULTS.has(result.reason));
const rejection = ({ reason, httpStatus }) => (httpStatus ? `${reason} ${httpStatus}` : reason);
const earliest = (times) => times.reduce((a, b) => Math.min(a, b), Infinity);

async function dueBatches(dir, binding, skip, now) {
  const mine = (await listRecords(dir, spoolFields)).filter(
    (entry) => entry.binding === binding && !skip.has(entry.ready) && claimable(entry)
  );
  return {
    due: mine.filter((entry) => entry.dueAt <= now).sort(freshFirst),
    nextDueAt: earliest(mine.map((entry) => entry.dueAt).filter((dueAt) => dueAt > now)),
  };
}

export async function shipSpool(dataDir, binding, runtime, { limit = SHIP_LIMIT, skip } = {}) {
  const dir = spoolDir(dataDir);
  const skipped = skip ?? new Set();
  const { due, nextDueAt } = await dueBatches(dir, binding, skipped, Date.now());
  const picked = due.slice(0, limit);
  const claimed = (await Promise.all(picked.map((entry) => claimRecord(dir, entry)))).filter(
    Boolean
  );
  const more = due.length > picked.length;
  if (claimed.length === 0) {
    return {
      shipped: 0,
      settled: 0,
      dropped: 0,
      rejected: [],
      outage: false,
      more: false,
      nextDueAt,
    };
  }
  const batches = await Promise.all(claimed.map((entry) => readClaimed(dir, entry)));
  await forgetJournaled(dataDir, batches.flatMap(journalOf));
  const results = await runtime.exportSpooled(batches);
  const round = { skip: skipped, answered: results.some((result) => !KEPT.has(result.status)) };
  const settled = await Promise.all(
    claimed.map((entry, i) => settle(dir, entry, results[i], round))
  );
  return {
    shipped: claimed.length,
    settled: settled.filter((outcome) => outcome.settled).length,
    dropped: settled.filter((outcome) => outcome.dropped).length,
    rejected: results.filter((result) => result.status === "rejected").map(rejection),
    outage: claimed.some((entry, i) => notTheBatch(entry, results[i])),
    more,
    nextDueAt: earliest([nextDueAt, ...settled.map((outcome) => outcome.dueAt)]),
  };
}

const shipperLock = (dataDir, binding) =>
  path.join(dataDir, `obs-shipper-${binding.slice(0, 32)}.pid`);

const lockOwner = async (lock) => Number(await readFile(lock, "utf8").catch(() => NaN));

export async function shipperRunning(dataDir, binding) {
  const pid = await lockOwner(shipperLock(dataDir, binding));
  return Number.isInteger(pid) && pid > 0 && !processGone(pid);
}

export async function claimShipper(dataDir, binding) {
  const lock = shipperLock(dataDir, binding);
  if (await shipperRunning(dataDir, binding)) return false;
  await unlink(lock).catch(() => undefined);
  try {
    await writeFile(lock, String(process.pid), { flag: "wx", mode: PRIVATE_FILE_MODE });
    return true;
  } catch {
    return false;
  }
}

export async function releaseShipper(dataDir, binding) {
  const lock = shipperLock(dataDir, binding);
  if ((await lockOwner(lock)) === process.pid) await unlink(lock).catch(() => undefined);
}
