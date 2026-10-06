import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
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

const CALL_KINDS = { PreToolUse: "policy", PostToolUse: "tool", PostToolUseFailure: "tool" };

export function eventCall({ event, input }) {
  const id = input?.tool_use_id;
  if (!Object.hasOwn(CALL_KINDS, event) || typeof id !== "string") return null;
  return `${CALL_KINDS[event]}:${id}`;
}

function spanCall({ attributes }) {
  const id = attributes["gen_ai.tool.call.id"];
  if (typeof id !== "string") return null;
  return `${attributes["armoriq.operation.category"] === "policy" ? "policy" : "tool"}:${id}`;
}

export const batchCalls = (batch) => batch.spans.map(spanCall).filter(Boolean);

export const settledEvents = (pending, { sinkFailures, written }) =>
  pending.filter((item) => item.failures === sinkFailures || written.has(item.call));

export const forgetEvent = (file) => unlink(file).catch(() => undefined);

export const JOURNAL_MAX_ENTRIES = 10_000;
const ADOPT_CONCURRENCY = 64;

export async function pruneJournal(dataDir, now = Date.now(), busy = new Set()) {
  const dir = journalDir(dataDir);
  const live = (await dropExpired(dir, await listRecords(dir, journalFields), now))
    .filter((entry) => entry.kind !== "draft")
    .sort((a, b) => b.at - a.at || b.seq - a.seq);
  const over = new Set(
    live.slice(JOURNAL_MAX_ENTRIES).filter((entry) => !busy.has(path.join(dir, entry.name)))
  );
  await Promise.all([...over].map((entry) => removeRecord(dir, entry.name)));
  return { live: live.filter((entry) => !over.has(entry)), dropped: over.size };
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
  const { live, dropped } = await pruneJournal(dataDir, now, busy);
  const due = live
    .filter(
      (entry) => entry.binding === binding && claimable(entry, busy.has(path.join(dir, entry.name)))
    )
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const adopted = new Array(due.length);
  let next = 0;
  const adoptNext = async () => {
    while (next < due.length) {
      const at = next++;
      adopted[at] = await adopt(dir, due[at]);
    }
  };
  await Promise.all(Array.from({ length: ADOPT_CONCURRENCY }, adoptNext));
  return { backlog: adopted.filter(Boolean), dropped };
}
