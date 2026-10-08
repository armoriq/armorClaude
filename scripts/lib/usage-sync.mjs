import { stat } from "node:fs/promises";
import path from "node:path";
import { sessionTranscriptPaths, summarizeSessionUsageByHour } from "@armoriq/sdk-dev";
import { readJson } from "./fs-store.mjs";
import { classifyTranscripts, copiedMessageKeys } from "./transcripts.mjs";

const STATE_VERSION = 2;

class RecordingSet extends Set {
  added = [];
  add(key) {
    if (!this.has(key)) this.added.push(key);
    return super.add(key);
  }
  withSkipped(keys, fn) {
    const fresh = keys.filter((key) => !this.has(key));
    for (const key of fresh) super.add(key);
    try {
      return fn();
    } finally {
      for (const key of fresh) this.delete(key);
    }
  }
}

/**
 * `skip` adds a window of UTC hours ("YYYY-MM-DDTHH", both bounds exclusive)
 * whose rows are recorded but never posted.
 */
export async function loadSyncState(statePath, { skip } = {}) {
  const raw = await readJson(statePath, null);
  const valid = raw?.version === STATE_VERSION && raw.sessions && typeof raw.sessions === "object";
  const state = valid ? raw : { version: STATE_VERSION, sessions: {} };
  const windows = state.skip ?? [];
  const known = windows.some((w) => w.after === skip?.after && w.before === skip?.before);
  return skip && !known ? { ...state, skip: [...windows, skip] } : state;
}

async function sessionFiles(mainPath) {
  const files = {};
  for (const file of sessionTranscriptPaths(mainPath)) {
    try {
      const s = await stat(file);
      files[file] = [s.size, s.mtimeMs];
    } catch {
      // removed between listing and stat
    }
  }
  return files;
}

function sameFiles(a, b) {
  if (!a) return false;
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  return keys.every((k) => a[k]?.[0] === b[k][0] && a[k]?.[1] === b[k][1]);
}

const entryTotal = (e) => e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens;

const zeroEntry = (model) => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const hourKey = ({ usageDate, usageHour }) => `${usageDate}T${String(usageHour).padStart(2, "0")}`;

/**
 * The rows to post for one session: every UTC hour whose per-model totals
 * differ from what was posted before. A model posted before but absent from an
 * hour now is sent with zero tokens, since the backend replaces each (session,
 * model, date, hour) row it receives and leaves the rest alone.
 */
function changedHours(usage, prevHours = {}) {
  const hours = {};
  const byHour = new Map(usage.hours.map((hour) => [hourKey(hour), hour.entries]));
  for (const [key, entries] of byHour) {
    hours[key] = Object.fromEntries(entries.map((e) => [e.model, entryTotal(e)]));
  }
  const rows = [];
  for (const key of new Set([...byHour.keys(), ...Object.keys(prevHours)])) {
    const now = hours[key] ?? {};
    const before = prevHours[key] ?? {};
    const models = new Set([...Object.keys(now), ...Object.keys(before)]);
    if ([...models].every((m) => now[m] === before[m])) continue;
    const vanished = Object.keys(before).filter((m) => !Object.hasOwn(now, m));
    const entries = [...(byHour.get(key) ?? []), ...vanished.map(zeroEntry)];
    const tokens = Object.values(now).reduce((a, b) => a + b, 0);
    rows.push({ usageDate: key.slice(0, 10), usageHour: Number(key.slice(11)), entries, tokens });
  }
  return { hours, rows };
}

const skipped = (hour, windows) => windows.some((w) => hour > w.after && hour < w.before);
const dueRows = (rows, windows = []) => rows.filter((row) => !skipped(hourKey(row), windows));

function countFailure(failures, failure) {
  const key = `${failure.status ?? ""} ${failure.reason}`;
  const known = failures.get(key);
  if (known) known.count++;
  else failures.set(key, { ...failure, count: 1 });
}

function rowFailure(sessionId, row, result) {
  return {
    sessionId,
    usageDate: row.usageDate,
    usageHour: row.usageHour,
    ...(result?.status ? { status: result.status } : {}),
    ...(result?.unreachable ? { unreachable: true } : {}),
    reason: result?.reason ?? "no reason given",
  };
}

async function postRows(post, rows, session, report, failures) {
  let ok = true;
  for (const row of rows) {
    const { usageDate, usageHour, entries } = row;
    const result = await post({ ...session, usageDate, usageHour, entries });
    if (result?.ok) {
      report.sessionHours++;
      report.tokens += row.tokens;
      continue;
    }
    ok = false;
    report.failed++;
    countFailure(failures, rowFailure(session.sessionId, row, result));
    if (result?.unreachable) return { ok, unreachable: true };
  }
  return { ok, unreachable: false };
}

/**
 * Post the session-hours that changed since the last run, reading only sessions
 * whose main or subagent transcripts changed size or mtime.
 *
 * Each session's entry in `state.sessions` keeps the message keys it counted.
 * The run's seen set starts with the keys of every session it does not read,
 * so a changed fork still skips history it copied from an unchanged original.
 * A session's entry is replaced only when all of its changed hours posted, so
 * a failed hour is retried on the next run. `state` is updated in place.
 */
export async function syncUsage({
  projectsDir,
  state,
  post,
  isArmored = () => false,
  deadline = Infinity,
}) {
  const groups = await classifyTranscripts(projectsDir);
  const mains = new Set(groups.main);
  for (const file of Object.keys(state.sessions)) {
    if (!mains.has(file)) delete state.sessions[file];
  }

  const current = new Map();
  for (const file of groups.main) current.set(file, await sessionFiles(file));
  const changed = groups.main.filter((f) => !sameFiles(state.sessions[f]?.files, current.get(f)));
  const changedSet = new Set(changed);

  const seen = new RecordingSet();
  for (const [file, entry] of Object.entries(state.sessions)) {
    if (changedSet.has(file)) continue;
    for (const key of entry.keys ?? []) seen.add(key);
  }

  const folded = new Set([...current.values()].flatMap((files) => Object.keys(files)));
  const report = {
    main: groups.main.length,
    subagent: groups.subagent.length,
    journal: groups.journal.length,
    other: groups.other.length,
    notRead: [...groups.subagent.filter((f) => !folded.has(f)), ...groups.other],
    changed: changed.length,
    read: 0,
    sessionHours: 0,
    tokens: 0,
    failed: 0,
    left: 0,
  };
  const failures = new Map();

  for (const [i, file] of changed.entries()) {
    if (Date.now() > deadline) {
      report.left = changed.length - i;
      break;
    }
    const sessionId = path.basename(file, ".jsonl");
    seen.added = [];
    let usage;
    try {
      const copied = copiedMessageKeys(file, sessionId);
      usage = seen.withSkipped(copied, () => summarizeSessionUsageByHour(file, { seen }));
    } catch (err) {
      report.failed++;
      countFailure(failures, { sessionId, reason: `could not read: ${err?.message ?? err}` });
      continue;
    }
    report.read++;
    const prev = state.sessions[file];
    const armored = Boolean(prev?.armored) || isArmored(sessionId);
    const { hours, rows } = changedHours(usage, prev?.hours);
    const due = dueRows(rows, state.skip);
    const session = { sessionId, repo: usage.repo, armored };
    const { ok, unreachable } = await postRows(post, due, session, report, failures);
    if (unreachable) {
      report.left = changed.length - i;
      break;
    }
    if (ok) {
      state.sessions[file] = {
        files: current.get(file),
        hours,
        keys: seen.added,
        ...(armored ? { armored: true } : {}),
      };
    }
  }
  report.failures = [...failures.values()];
  return report;
}
