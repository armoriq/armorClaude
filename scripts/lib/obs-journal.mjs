import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./fs-store.mjs";
import { processGone } from "./obs-spool.mjs";

export const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_MAX_AGE_MS = 60_000;

const ENTRY = /^(\d+)-(\d+)-(\d+)-([0-9a-f]{64})-([0-9a-f-]{36})\.json(\.tmp\..+)?$/;
const INPUT_FIELDS = [
  "session_id",
  "hook_event_name",
  "tool_name",
  "tool_use_id",
  "expansion_type",
  "command_name",
];
let sequence = 0;

export function journalDir(dataDir) {
  return path.join(dataDir, "obs-journal");
}

function decisionOnly(output) {
  const permissionDecision = output?.hookSpecificOutput?.permissionDecision;
  return permissionDecision ? { hookSpecificOutput: { permissionDecision } } : null;
}

export function journalEntryPath(dataDir, binding, at) {
  return path.join(
    journalDir(dataDir),
    `${at}-${sequence++}-${process.pid}-${binding}-${randomUUID()}.json`
  );
}

export async function journalEvent(file, { event, input, output, at }) {
  const fields = INPUT_FIELDS.filter((key) => Object.hasOwn(input, key));
  const record = {
    event,
    at,
    input: Object.fromEntries(fields.map((key) => [key, input[key]])),
    output: decisionOnly(output),
  };
  await ensurePrivateDir(path.dirname(file));
  await writePrivateFile(file, JSON.stringify(record));
  return file;
}

export const forgetEvent = (file) => unlink(file).catch(() => undefined);

function parseEntry(name) {
  const match = ENTRY.exec(name);
  if (!match) return null;
  const [, at, seq, owner, binding, id, draft] = match;
  return { name, at: Number(at), seq: Number(seq), owner: Number(owner), binding, id, draft };
}

async function listJournal(dir) {
  return (await readdir(dir).catch(() => [])).map(parseEntry).filter(Boolean);
}

const expired = (entry, now) =>
  now - entry.at > (entry.draft ? DRAFT_MAX_AGE_MS : JOURNAL_MAX_AGE_MS);

export async function pruneJournal(dataDir, now = Date.now()) {
  const dir = journalDir(dataDir);
  const entries = await listJournal(dir);
  const live = entries.filter((entry) => !expired(entry, now));
  await Promise.all(
    entries
      .filter((entry) => !live.includes(entry))
      .map((entry) => forgetEvent(path.join(dir, entry.name)))
  );
  return live.filter((entry) => !entry.draft);
}

async function adopt(dir, entry) {
  const file = path.join(
    dir,
    `${entry.at}-${entry.seq}-${process.pid}-${entry.binding}-${entry.id}.json`
  );
  try {
    if (entry.owner !== process.pid) await rename(path.join(dir, entry.name), file);
    return { file, record: JSON.parse(await readFile(file, "utf8")) };
  } catch {
    await forgetEvent(file);
    return null;
  }
}

const replayable = (dir, entry, binding, busy) =>
  entry.binding === binding &&
  (entry.owner === process.pid ? !busy.has(path.join(dir, entry.name)) : processGone(entry.owner));

export async function journalBacklog(dataDir, binding, busy, now = Date.now()) {
  const dir = journalDir(dataDir);
  const due = (await pruneJournal(dataDir, now))
    .filter((entry) => replayable(dir, entry, binding, busy))
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const adopted = [];
  for (const entry of due) adopted.push(await adopt(dir, entry));
  return adopted.filter(Boolean);
}
