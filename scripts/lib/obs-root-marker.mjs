import { createHash, randomUUID } from "node:crypto";
import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, PRIVATE_FILE_MODE } from "./fs-store.mjs";

function markerPath(dataDir, sessionId) {
  const name = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  return path.join(dataDir, "obs-roots", name);
}

async function readMarker(marker) {
  const text = await readFile(marker, "utf8").catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (text === null) return null;
  const { startTime, pid, ended } = JSON.parse(text);
  return { startTime: new Date(startTime), pid, ended: ended === true };
}

async function writeDraft(marker, state) {
  const draft = `${marker}.${randomUUID()}`;
  await writeFile(draft, JSON.stringify({ ...state, pid: process.pid }), {
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
  return draft;
}

// Linked into place, never half-written: a reader sees a whole marker or none.
async function linkMarker(marker, startTime) {
  const draft = await writeDraft(marker, { startTime });
  try {
    await link(draft, marker);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  } finally {
    await rm(draft, { force: true });
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export async function claimRootStart(dataDir, sessionId) {
  const marker = markerPath(dataDir, sessionId);
  await ensurePrivateDir(path.dirname(marker));
  const now = new Date();
  if (await linkMarker(marker, now)) return now;
  return (await readMarker(marker))?.startTime ?? now;
}

export async function takeRootEnd(dataDir, sessionId) {
  const marker = markerPath(dataDir, sessionId);
  const recorded = await readMarker(marker);
  if (!recorded) return false;
  if (recorded.pid === process.pid) return true;
  if (recorded.ended || isAlive(recorded.pid)) return false;
  const stale = `${marker}.${randomUUID()}`;
  try {
    await rename(marker, stale);
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  await rm(stale, { force: true });
  return linkMarker(marker, recorded.startTime);
}

export async function markRootEnded(dataDir, sessionId) {
  const marker = markerPath(dataDir, sessionId);
  const recorded = await readMarker(marker);
  if (recorded?.pid !== process.pid) return;
  await rename(await writeDraft(marker, { startTime: recorded.startTime, ended: true }), marker);
}

export async function releaseRootStart(dataDir, sessionId) {
  await rm(markerPath(dataDir, sessionId), { force: true });
}
