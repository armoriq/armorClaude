import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import armoriqSdk from "@armoriq/sdk-dev";
import { ensurePrivateDir, writePrivateFile } from "./fs-store.mjs";
import { OBS_RECORD_MAX_AGE_MS } from "./obs-ages.mjs";

const { sessionUsageCalls } = armoriqSdk;
const prunedDirs = new Set();

const isCopied = (line, sessionId) =>
  Boolean(line?.forkedFrom) ||
  (typeof line?.sessionId === "string" && line.sessionId !== sessionId);

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonLines(transcriptPath) {
  try {
    return readFileSync(transcriptPath, "utf8").split("\n").map(parse);
  } catch {
    return [];
  }
}

function lineKey(line) {
  const id = line.message?.id ?? line.payload?.id;
  if (typeof id !== "string" || !id) return null;
  return `${id}:${typeof line.requestId === "string" ? line.requestId : ""}`;
}

const copiedKeys = (transcriptPath, sessionId) =>
  jsonLines(transcriptPath)
    .filter((line) => isCopied(line, sessionId))
    .map(lineKey)
    .filter(Boolean);

export function newUsageCalls(transcriptPath, sessionId, cutoff, sentKeys = []) {
  if (cutoff === null) return [];
  const seen = new Set([...copiedKeys(transcriptPath, sessionId), ...sentKeys]);
  return sessionUsageCalls(transcriptPath, { seen }).filter((call) => call.timestampMs >= cutoff);
}

export const firstMessageAt = (transcriptPath, sessionId, cutoff) =>
  newUsageCalls(transcriptPath, sessionId, cutoff)[0]?.timestampMs;

function sentPath(dataDir, binding, sessionId) {
  const name = createHash("sha256").update(`${binding}\n${sessionId}`).digest("hex").slice(0, 32);
  return path.join(dataDir, "obs-calls", name);
}

async function pruneOnce(dir) {
  if (prunedDirs.has(dir)) return;
  prunedDirs.add(dir);
  const now = Date.now();
  const prune = async (name) => {
    const file = path.join(dir, name);
    if (now - (await stat(file)).mtimeMs > OBS_RECORD_MAX_AGE_MS) await rm(file, { force: true });
  };
  await Promise.allSettled((await readdir(dir)).map(prune));
}

export async function readSentCalls(dataDir, binding, sessionId) {
  const file = sentPath(dataDir, binding, sessionId);
  await ensurePrivateDir(path.dirname(file));
  await pruneOnce(path.dirname(file)).catch(() => undefined);
  const keys = parse(await readFile(file, "utf8").catch(() => "[]"));
  return Array.isArray(keys) ? keys : [];
}

export function writeSentCalls(dataDir, binding, sessionId, keys) {
  return writePrivateFile(sentPath(dataDir, binding, sessionId), JSON.stringify(keys));
}
