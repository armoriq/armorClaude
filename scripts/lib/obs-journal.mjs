import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./fs-store.mjs";
import { claimable, claimRecord, dropExpired, listRecords, readClaimed } from "./obs-records.mjs";

const FIELDS = /^\d+-(\d+)-([0-9a-f]{64})-[0-9a-f-]{36}\.json$/;
const INPUT_FIELDS = [
  "session_id",
  "hook_event_name",
  "tool_name",
  "tool_use_id",
  "expansion_type",
  "command_name",
];
let sequence = 0;

const journalDir = (dataDir) => path.join(dataDir, "obs-journal");

function journalFields(ready) {
  const match = FIELDS.exec(ready);
  return match && { seq: Number(match[1]), binding: match[2] };
}

function decisionOnly(output) {
  const permissionDecision = output?.hookSpecificOutput?.permissionDecision;
  return permissionDecision ? { hookSpecificOutput: { permissionDecision } } : null;
}

export function journalEntryPath(dataDir, binding, at) {
  const name = `${at}-${sequence++}-${binding}-${randomUUID()}.json.claim-${process.pid}`;
  return path.join(journalDir(dataDir), name);
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

export async function pruneJournal(dataDir, now = Date.now()) {
  const dir = journalDir(dataDir);
  const live = await dropExpired(dir, await listRecords(dir, journalFields), now);
  return live.filter((entry) => entry.kind !== "draft");
}

async function adopt(dir, entry) {
  const claimed = await claimRecord(dir, entry);
  if (!claimed) return null;
  const file = path.join(dir, claimed.claimed);
  const record = await readClaimed(dir, claimed);
  if (record) return { file, record };
  await forgetEvent(file);
  return null;
}

export async function journalBacklog(dataDir, binding, busy, now = Date.now()) {
  const dir = journalDir(dataDir);
  const due = (await pruneJournal(dataDir, now))
    .filter(
      (entry) => entry.binding === binding && claimable(entry, busy.has(path.join(dir, entry.name)))
    )
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const adopted = [];
  for (const entry of due) adopted.push(await adopt(dir, entry));
  return adopted.filter(Boolean);
}
