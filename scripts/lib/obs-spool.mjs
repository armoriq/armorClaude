import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./fs-store.mjs";

export const SPOOL_MAX_BYTES = 8 * 1024 * 1024;
export const SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SPOOL_DRAFT_MAX_AGE_MS = 60_000;
export const SPOOL_SHIP_LIMIT = 64;

const ENTRY = /^((\d+)-(\d+)-([0-9a-f]{32})-[0-9a-f-]{36}\.json)(\.claim-(\d+)|\.tmp\..+)?$/;

export function spoolDir(dataDir) {
  return path.join(dataDir, "obs-spool");
}

function parseEntry(name) {
  const match = ENTRY.exec(name);
  if (!match) return null;
  const [, ready, at, bytes, binding, suffix, owner] = match;
  const kind = owner ? "claim" : suffix ? "draft" : "ready";
  return { name, ready, at: Number(at), bytes: Number(bytes), binding, kind, owner: Number(owner) };
}

async function listSpool(dir) {
  const names = await readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names
    .map(parseEntry)
    .filter(Boolean)
    .sort((a, b) => b.at - a.at);
}

const remove = (dir, name) => unlink(path.join(dir, name)).catch(() => undefined);

function expired(entry, now) {
  const maxAge = entry.kind === "draft" ? SPOOL_DRAFT_MAX_AGE_MS : SPOOL_MAX_AGE_MS;
  return now - entry.at > maxAge;
}

export async function pruneSpool(dataDir, now = Date.now()) {
  const dir = spoolDir(dataDir);
  let kept = 0;
  const doomed = (await listSpool(dir)).filter((entry) => {
    if (expired(entry, now)) return true;
    if (entry.kind !== "ready") return false;
    kept += entry.bytes;
    return kept > SPOOL_MAX_BYTES;
  });
  await Promise.all(doomed.map((entry) => remove(dir, entry.name)));
}

export async function writeSpoolBatch(dataDir, binding, batch) {
  const dir = spoolDir(dataDir);
  const text = JSON.stringify(batch);
  const name = `${Date.now()}-${Buffer.byteLength(text)}-${binding}-${randomUUID()}.json`;
  await ensurePrivateDir(dir);
  await writePrivateFile(path.join(dir, name), text);
  await pruneSpool(dataDir);
}

function ownerGone(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

const claimable = (entry) =>
  entry.kind === "ready" || (entry.kind === "claim" && ownerGone(entry.owner));

async function claim(dir, entry) {
  const claimed = `${entry.ready}.claim-${process.pid}`;
  try {
    await rename(path.join(dir, entry.name), path.join(dir, claimed));
    return { ...entry, claimed };
  } catch {
    return null;
  }
}

async function readBatch(dir, entry) {
  try {
    return JSON.parse(await readFile(path.join(dir, entry.claimed), "utf8"));
  } catch {
    return null;
  }
}

function settle(dir, entry, result) {
  if (result.status !== "failed") return remove(dir, entry.claimed);
  return rename(path.join(dir, entry.claimed), path.join(dir, entry.ready)).catch(() => undefined);
}

export async function shipSpool(dataDir, binding, runtime) {
  const dir = spoolDir(dataDir);
  const due = (await listSpool(dir))
    .filter((entry) => entry.binding === binding && claimable(entry))
    .reverse();
  const picked = due.slice(0, SPOOL_SHIP_LIMIT);
  const claimed = (await Promise.all(picked.map((entry) => claim(dir, entry)))).filter(Boolean);
  if (claimed.length === 0) return { shipped: 0, failed: false, more: false };
  const batches = await Promise.all(claimed.map((entry) => readBatch(dir, entry)));
  const results = await runtime.exportSpooled(batches);
  await Promise.all(claimed.map((entry, i) => settle(dir, entry, results[i])));
  return {
    shipped: claimed.length,
    failed: results.some((result) => result.status === "failed"),
    more: due.length > picked.length,
  };
}
