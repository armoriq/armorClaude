import armoriqSdk from "@armoriq/sdk-dev";
import { newUsageCalls } from "./obs-usage-calls.mjs";

const { MAX_BATCH_BYTES, MAX_BATCH_ENTRIES, MAX_BATCH_SNAPSHOTS, usageCallRecords } = armoriqSdk;

const keysOf = (parts) => parts.flatMap((c) => c.records.map((r) => r.key));
const sentIn = (state, generation) =>
  state.calls?.generation === generation ? state.calls.sent : [];

function queuedKeys(pending, generation, sessionId) {
  const own = pending
    .filter((b) => b.generation === generation)
    .flatMap((b) => (b.calls ?? []).filter((c) => c.sessionId === sessionId));
  return keysOf(own);
}

export function callChange(
  { sessionId, transcript },
  state,
  { cutoff, generation, pending, repo }
) {
  const skip = [...sentIn(state, generation), ...queuedKeys(pending, generation, sessionId)];
  const records = usageCallRecords(newUsageCalls(transcript, sessionId, cutoff, skip));
  if (!records.length) return [];
  return [{ sessionId, armored: true, ...(repo ? { repo: repo.slice(0, 200) } : {}), records }];
}

export const noteCalls = (state, generation, parts) => ({
  ...state,
  calls: { generation, sent: [...new Set([...sentIn(state, generation), ...keysOf(parts)])] },
});

function chunks(records) {
  const out = [];
  for (let i = 0; i < records.length; i += MAX_BATCH_ENTRIES) {
    out.push(records.slice(i, i + MAX_BATCH_ENTRIES));
  }
  return out;
}

export function callBatches(callSessions, overheadBytes = 512) {
  const parts = callSessions.flatMap((s) =>
    chunks(s.records).map((records) => ({ ...s, records }))
  );
  const groups = [];
  let current = [];
  let count = 0;
  let bytes = overheadBytes;
  for (const part of parts) {
    const size = Buffer.byteLength(JSON.stringify(part)) + 1;
    const full =
      current.length === MAX_BATCH_SNAPSHOTS ||
      count + part.records.length > MAX_BATCH_ENTRIES ||
      bytes + size > MAX_BATCH_BYTES;
    if (full && current.length) {
      groups.push(current);
      current = [];
      count = 0;
      bytes = overheadBytes;
    }
    current.push(part);
    count += part.records.length;
    bytes += size;
  }
  if (current.length) groups.push(current);
  return groups;
}
