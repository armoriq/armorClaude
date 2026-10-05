import { createHash, randomUUID } from "node:crypto";
import { access, link, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, PRIVATE_FILE_MODE } from "./fs-store.mjs";

const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_MAX_AGE_MS = 60 * 60 * 1000;
const prunedDirs = new Set();

function markerPath(dataDir, sessionId) {
  const name = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return path.join(dataDir, "obs-roots", name);
}

async function placeMarker(marker, startTime, place) {
  const draft = `${marker}.${randomUUID()}`;
  try {
    await writeFile(draft, JSON.stringify({ startTime }), { mode: PRIVATE_FILE_MODE, flag: "wx" });
    await place(draft, marker);
  } finally {
    await rm(draft, { force: true });
  }
}

async function linkMarker(marker, startTime) {
  try {
    await placeMarker(marker, startTime, link);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

function parseStartTime(text) {
  try {
    const { startTime } = JSON.parse(text) ?? {};
    const parsed = new Date(startTime);
    return typeof startTime === "string" && !Number.isNaN(parsed.getTime()) ? parsed : null;
  } catch {
    return null;
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
    return { startTime: parseStartTime(text), writtenAt: stats.mtime };
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
    const maxAge = name.includes(".") ? DRAFT_MAX_AGE_MS : MARKER_MAX_AGE_MS;
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
  await placeMarker(marker, recorded.writtenAt, rename);
  return recorded.writtenAt;
}

export function claimRootStart(dataDir, sessionId) {
  return claim(dataDir, sessionId).catch(() => null);
}

export function rootStartReleased(dataDir, sessionId) {
  const missing = (err) => err?.code === "ENOENT";
  return access(markerPath(dataDir, sessionId)).then(() => false, missing);
}

export async function releaseRootStart(dataDir, sessionId) {
  await rm(markerPath(dataDir, sessionId), { force: true }).catch(() => undefined);
}
