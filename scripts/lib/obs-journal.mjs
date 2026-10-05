import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./fs-store.mjs";
import { processGone } from "./obs-spool.mjs";

export const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const ENTRY = /^(\d+)-(\d+)-(\d+)-([0-9a-f-]{36})\.json$/;
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
  const decision = output?.hookSpecificOutput;
  if (!decision) return null;
  const { permissionDecision, permissionDecisionReason } = decision;
  return { hookSpecificOutput: { permissionDecision, permissionDecisionReason } };
}

export async function journalEvent(dataDir, event, input, output) {
  const dir = journalDir(dataDir);
  const fields = INPUT_FIELDS.filter((key) => Object.hasOwn(input, key));
  const record = {
    event,
    input: Object.fromEntries(fields.map((key) => [key, input[key]])),
    output: decisionOnly(output),
  };
  const name = `${Date.now()}-${sequence++}-${process.pid}-${randomUUID()}.json`;
  await ensurePrivateDir(dir);
  await writePrivateFile(path.join(dir, name), JSON.stringify(record));
  return path.join(dir, name);
}

export const forgetEvent = (file) => unlink(file).catch(() => undefined);

function parseEntry(name) {
  const match = ENTRY.exec(name);
  if (!match) return null;
  const [, at, seq, owner, id] = match;
  return { name, at: Number(at), seq: Number(seq), owner: Number(owner), id };
}

async function adopt(dir, entry) {
  const file = path.join(dir, `${entry.at}-${entry.seq}-${process.pid}-${entry.id}.json`);
  try {
    await rename(path.join(dir, entry.name), file);
    return { file, record: JSON.parse(await readFile(file, "utf8")) };
  } catch {
    await forgetEvent(file);
    return null;
  }
}

export async function adoptOrphanedEvents(dataDir, now = Date.now()) {
  const dir = journalDir(dataDir);
  const orphans = (await readdir(dir).catch(() => []))
    .map(parseEntry)
    .filter((entry) => entry && entry.owner !== process.pid && processGone(entry.owner))
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const adopted = [];
  for (const entry of orphans) {
    if (now - entry.at > JOURNAL_MAX_AGE_MS) await forgetEvent(path.join(dir, entry.name));
    else adopted.push(await adopt(dir, entry));
  }
  return adopted.filter(Boolean);
}
