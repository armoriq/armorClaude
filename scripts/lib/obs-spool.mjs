import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./fs-store.mjs";
import {
  claimable,
  claimRecord,
  dropExpired,
  listRecords,
  readClaimed,
  removeRecord,
} from "./obs-records.mjs";

const SPOOL_MAX_BYTES = 8 * 1024 * 1024;
export const SPOOL_MAX_TRIES = 8;
const SHIP_LIMIT = 64;
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 10 * 60_000;
const KEPT = new Set(["failed", "unsupported"]);
const BATCH_FAULTS = new Set(["export_failed", "deadline"]);

const FIELDS = /^\d+-(\d+)-([0-9a-f]{64})-([0-9a-f-]{36})-(\d+)-(\d+)\.json$/;
const BINDING = /^[0-9a-f]{64}$/;

const spoolDir = (dataDir) => path.join(dataDir, "obs-spool");

function spoolFields(ready) {
  const match = FIELDS.exec(ready);
  if (!match) return null;
  const [, bytes, binding, id, tries, dueAt] = match;
  return { bytes: Number(bytes), binding, id, tries: Number(tries), dueAt: Number(dueAt) };
}

const batchName = ({ at, bytes, binding, id, tries, dueAt }) =>
  `${at}-${bytes}-${binding}-${id}-${tries}-${dueAt}.json`;

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
}

export async function writeSpoolBatch(dataDir, batch) {
  if (!BINDING.test(batch?.binding)) throw new Error("a spooled batch needs its runtime's binding");
  const dir = spoolDir(dataDir);
  const text = JSON.stringify(batch);
  const bytes = Buffer.byteLength(text);
  const id = randomUUID();
  const name = batchName({ at: Date.now(), bytes, binding: batch.binding, id, tries: 0, dueAt: 0 });
  await ensurePrivateDir(dir);
  await writePrivateFile(path.join(dir, name), text);
  await pruneSpool(dir);
}

export function shipRetryDelayMs(failures) {
  return Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS);
}

async function settle(dir, entry, result, skip) {
  const tries = entry.tries + (BATCH_FAULTS.has(result.reason) ? 1 : 0);
  if (!KEPT.has(result.status) || tries >= SPOOL_MAX_TRIES) {
    await removeRecord(dir, entry.claimed);
    return { settled: !KEPT.has(result.status), dropped: KEPT.has(result.status), dueAt: Infinity };
  }
  if (result.status === "unsupported") skip.add(entry.ready);
  const retry = tries > entry.tries;
  const dueAt = retry ? Date.now() + shipRetryDelayMs(tries) : entry.dueAt;
  const next = path.join(dir, batchName({ ...entry, tries, dueAt }));
  await rename(path.join(dir, entry.claimed), next).catch(() => undefined);
  return { settled: false, dropped: false, dueAt: retry ? dueAt : Infinity };
}

const freshFirst = (a, b) => a.tries - b.tries || a.at - b.at;
const notTheBatch = (entry, result) =>
  result.status === "failed" && (entry.tries === 0 || !BATCH_FAULTS.has(result.reason));
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
    return { shipped: 0, settled: 0, dropped: 0, outage: false, more: false, nextDueAt };
  }
  const batches = await Promise.all(claimed.map((entry) => readClaimed(dir, entry)));
  const results = await runtime.exportSpooled(batches);
  const settled = await Promise.all(
    claimed.map((entry, i) => settle(dir, entry, results[i], skipped))
  );
  return {
    shipped: claimed.length,
    settled: settled.filter((outcome) => outcome.settled).length,
    dropped: settled.filter((outcome) => outcome.dropped).length,
    outage: claimed.some((entry, i) => notTheBatch(entry, results[i])),
    more,
    nextDueAt: earliest([nextDueAt, ...settled.map((outcome) => outcome.dueAt)]),
  };
}
