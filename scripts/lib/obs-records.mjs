import { readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { OBS_DRAFT_MAX_AGE_MS, OBS_RECORD_MAX_AGE_MS } from "./obs-ages.mjs";

const NAME = /^((\d+)-.+?\.json)(?:\.claim-(\d+))?(\.tmp\..+)?$/;

function processGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function parseRecord(name, fields) {
  const match = NAME.exec(name);
  const parsed = match && fields(match[1]);
  if (!parsed) return null;
  const [, ready, at, owner, draft] = match;
  const kind = draft ? "draft" : owner ? "claim" : "ready";
  return { ...parsed, name, ready, at: Number(at), kind, owner: Number(owner) };
}

export async function listRecords(dir, fields) {
  const names = await readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return names.map((name) => parseRecord(name, fields)).filter(Boolean);
}

export const removeRecord = (dir, name) => unlink(path.join(dir, name)).catch(() => undefined);

const expired = (entry, now) =>
  now - entry.at > (entry.kind === "draft" ? OBS_DRAFT_MAX_AGE_MS : OBS_RECORD_MAX_AGE_MS);

export async function dropExpired(dir, entries, now) {
  const [old, live] = [
    entries.filter((e) => expired(e, now)),
    entries.filter((e) => !expired(e, now)),
  ];
  await Promise.all(old.map((entry) => removeRecord(dir, entry.name)));
  return live;
}

export const claimable = (entry, busy = false) =>
  entry.kind === "ready" ||
  (entry.kind === "claim" && (entry.owner === process.pid ? !busy : processGone(entry.owner)));

export async function claimRecord(dir, entry) {
  const claimed = `${entry.ready}.claim-${process.pid}`;
  try {
    await rename(path.join(dir, entry.name), path.join(dir, claimed));
    return { ...entry, claimed };
  } catch {
    return null;
  }
}

export async function readClaimed(dir, entry) {
  try {
    return JSON.parse(await readFile(path.join(dir, entry.claimed), "utf8"));
  } catch {
    return null;
  }
}
