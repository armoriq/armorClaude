import { createHash, randomUUID } from "node:crypto";
import { link, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, PRIVATE_FILE_MODE } from "./fs-store.mjs";
import { OBS_DRAFT_MAX_AGE_MS, OBS_RECORD_MAX_AGE_MS } from "./obs-ages.mjs";

const prunedDirs = new Set();

function markerPath(dataDir, sessionId) {
  const name = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return path.join(dataDir, "obs-roots", name);
}

async function placeMarker(marker, record, place) {
  const draft = `${marker}.${randomUUID()}`;
  try {
    await writeFile(draft, JSON.stringify(record), { mode: PRIVATE_FILE_MODE, flag: "wx" });
    await place(draft, marker);
  } finally {
    await rm(draft, { force: true });
  }
}

async function linkMarker(marker, startTime) {
  try {
    await placeMarker(marker, { startTime }, link);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

function parseDate(value) {
  const parsed = new Date(value);
  return typeof value === "string" && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function parseMarker(text) {
  try {
    const { startTime, endedAt } = JSON.parse(text) ?? {};
    return { startTime: parseDate(startTime), endedAt: parseDate(endedAt) };
  } catch {
    return { startTime: null, endedAt: null };
  }
}

async function readMarker(marker) {
  const handle = await open(marker, "r").catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (!handle) return null;
  try {
    const [text, stats] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
    return { ...parseMarker(text), writtenAt: stats.mtime };
  } finally {
    await handle.close();
  }
}

async function pruneOnce(dir) {
  if (prunedDirs.has(dir)) return;
  prunedDirs.add(dir);
  const now = Date.now();
  const prune = async (name) => {
    const file = path.join(dir, name);
    const maxAge = name.includes(".") ? OBS_DRAFT_MAX_AGE_MS : OBS_RECORD_MAX_AGE_MS;
    if (now - (await stat(file)).mtimeMs > maxAge) await rm(file, { force: true });
  };
  await Promise.allSettled((await readdir(dir)).map(prune));
}

async function claim(dataDir, sessionId) {
  const marker = markerPath(dataDir, sessionId);
  await ensurePrivateDir(path.dirname(marker));
  const now = new Date();
  if (await linkMarker(marker, now)) {
    await pruneOnce(path.dirname(marker)).catch(() => undefined);
    return now;
  }
  const recorded = await readMarker(marker);
  if (!recorded) return now;
  if (recorded.startTime) return recorded.startTime;
  // Readers of one unreadable marker share its mtime, so racing rewrites agree.
  await placeMarker(marker, { startTime: recorded.writtenAt }, rename);
  return recorded.writtenAt;
}

export function claimRootStart(dataDir, sessionId) {
  return claim(dataDir, sessionId).catch(() => null);
}

export async function rootEndedAt(dataDir, sessionId) {
  return (await readMarker(markerPath(dataDir, sessionId)))?.endedAt ?? null;
}

export async function markRootEnded(dataDir, sessionId, endedAt) {
  const marker = markerPath(dataDir, sessionId);
  await ensurePrivateDir(path.dirname(marker));
  const startTime = (await readMarker(marker))?.startTime ?? endedAt;
  await placeMarker(marker, { startTime, endedAt }, rename);
}
