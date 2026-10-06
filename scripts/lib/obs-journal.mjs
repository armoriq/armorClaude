import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./fs-store.mjs";
import { DECISION_CODE } from "./hook-output.mjs";
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
  if (!permissionDecision) return null;
  const decisionCode = output[DECISION_CODE];
  return { hookSpecificOutput: { permissionDecision }, ...(decisionCode ? { decisionCode } : {}) };
}

function withDecisionCode(record) {
  const code = record.output?.decisionCode;
  return code ? { ...record, output: { ...record.output, [DECISION_CODE]: code } } : record;
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
  if (record) return { file, record: withDecisionCode(record) };
  await forgetEvent(file);
  return null;
}

export const journalName = (file) => path.basename(file).replace(/\.claim-\d+$/, "");

export async function journalBacklog(dataDir, binding, busy, now = Date.now(), spooled = null) {
  const dir = journalDir(dataDir);
  const due = (await pruneJournal(dataDir, now))
    .filter(
      (entry) => entry.binding === binding && claimable(entry, busy.has(path.join(dir, entry.name)))
    )
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const landed = due.length > 0 && spooled ? await spooled() : new Set();
  const adopted = [];
  for (const entry of due) {
    if (landed.has(entry.ready)) await forgetEvent(path.join(dir, entry.name));
    else adopted.push(await adopt(dir, entry));
  }
  return adopted.filter(Boolean);
}
