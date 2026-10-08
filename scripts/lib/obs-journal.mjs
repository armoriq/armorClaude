import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./fs-store.mjs";
import { DECISION_CODE } from "./hook-output.mjs";
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

export async function journalEvent(file, { event, input, output, at, id }) {
  const fields = INPUT_FIELDS.filter((key) => Object.hasOwn(input, key));
  const record = {
    event,
    at,
    id,
    input: Object.fromEntries(fields.map((key) => [key, input[key]])),
    output: decisionOnly(output),
  };
  await ensurePrivateDir(path.dirname(file));
  await writePrivateFile(file, JSON.stringify(record));
  return file;
}

const CALL_KINDS = {
  PreToolUse: "policy",
  PostToolUse: "tool",
  PostToolUseFailure: "tool",
  UserPromptExpansion: "command",
};
const SPAN_KINDS = new Set(["policy", "command"]);

const callId = ({ event, input, id }) =>
  event === "UserPromptExpansion" ? id : input?.tool_use_id;

export function eventCall(record) {
  const id = callId(record);
  if (!Object.hasOwn(CALL_KINDS, record.event) || typeof id !== "string") return null;
  return `${CALL_KINDS[record.event]}:${id}`;
}

function spanCall({ attributes }) {
  const id = attributes["gen_ai.tool.call.id"];
  if (typeof id !== "string") return null;
  const category = attributes["armoriq.operation.category"];
  return `${SPAN_KINDS.has(category) ? category : "tool"}:${id}`;
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
    live
      .slice(JOURNAL_MAX_ENTRIES)
      .filter((entry) => claimable(entry, busy.has(path.join(dir, entry.name))))
  );
  await Promise.all([...over].map((entry) => removeRecord(dir, entry.name)));
  return { live: live.filter((entry) => !over.has(entry)), dropped: over.size };
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
  const { live, dropped } = await pruneJournal(dataDir, now, busy);
  const due = live
    .filter(
      (entry) => entry.binding === binding && claimable(entry, busy.has(path.join(dir, entry.name)))
    )
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const landed = due.length > 0 && spooled ? await spooled() : new Set();
  const spooledAlready = due.filter((entry) => landed.has(entry.ready));
  await Promise.all(spooledAlready.map((entry) => forgetEvent(path.join(dir, entry.name))));
  const fresh = due.filter((entry) => !landed.has(entry.ready));
  const adopted = new Array(fresh.length);
  let next = 0;
  const adoptNext = async () => {
    while (next < fresh.length) {
      const at = next++;
      adopted[at] = await adopt(dir, fresh[at]);
    }
  };
  await Promise.all(Array.from({ length: ADOPT_CONCURRENCY }, adoptNext));
  return { backlog: adopted.filter(Boolean), dropped };
}
