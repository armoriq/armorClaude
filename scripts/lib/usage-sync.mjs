import { stat } from "node:fs/promises";
import path from "node:path";
import { sessionTranscriptPaths, summarizeSessionUsageByDay } from "@armoriq/sdk-dev";
import { readJson } from "./fs-store.mjs";
import { classifyTranscripts } from "./transcripts.mjs";

const STATE_VERSION = 2;

class RecordingSet extends Set {
  added = [];
  add(key) {
    if (!this.has(key)) this.added.push(key);
    return super.add(key);
  }
}

export async function loadSyncState(statePath) {
  const raw = await readJson(statePath, null);
  if (raw?.version === STATE_VERSION && raw.sessions && typeof raw.sessions === "object") {
    return raw;
  }
  return { version: STATE_VERSION, sessions: {} };
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

/**
 * The rows to post for one session: every day whose per-model totals differ
 * from what was posted before. A model posted before but absent from a day now
 * is sent with zero tokens, since the backend replaces each (session, model,
 * day) row it receives and leaves the rest alone.
 */
function changedDays(usage, prevDays = {}) {
  const days = {};
  const byDay = new Map(usage.days.map((day) => [day.usageDate, day.entries]));
  for (const [usageDate, entries] of byDay) {
    days[usageDate] = Object.fromEntries(entries.map((e) => [e.model, entryTotal(e)]));
  }
  const rows = [];
  for (const usageDate of new Set([...byDay.keys(), ...Object.keys(prevDays)])) {
    const now = days[usageDate] ?? {};
    const before = prevDays[usageDate] ?? {};
    const models = new Set([...Object.keys(now), ...Object.keys(before)]);
    if ([...models].every((m) => now[m] === before[m])) continue;
    const vanished = Object.keys(before).filter((m) => !Object.hasOwn(now, m));
    const entries = [...(byDay.get(usageDate) ?? []), ...vanished.map(zeroEntry)];
    const tokens = Object.values(now).reduce((a, b) => a + b, 0);
    rows.push({ usageDate, entries, tokens });
  }
  return { days, rows };
}

/**
 * Post the session-days that changed since the last run, reading only sessions
 * whose main or subagent transcripts changed size or mtime.
 *
 * Each session's entry in `state.sessions` keeps the message keys it counted.
 * The run's seen set starts with the keys of every session it does not read,
 * so a changed fork still skips history it copied from an unchanged original.
 * A session's entry is replaced only when all of its changed days posted, so a
 * failed day is retried on the next run. `state` is updated in place.
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
    sessionDays: 0,
    tokens: 0,
    failed: 0,
    left: 0,
  };

  for (const [i, file] of changed.entries()) {
    if (Date.now() > deadline) {
      report.left = changed.length - i;
      break;
    }
    const sessionId = path.basename(file, ".jsonl");
    seen.added = [];
    let usage;
    try {
      usage = summarizeSessionUsageByDay(file, { seen });
    } catch {
      report.failed++;
      continue;
    }
    report.read++;
    const prev = state.sessions[file];
    const armored = Boolean(prev?.armored) || isArmored(sessionId);
    const { days, rows } = changedDays(usage, prev?.days);
    let ok = true;
    for (const row of rows) {
      const result = await post({
        sessionId,
        usageDate: row.usageDate,
        repo: usage.repo,
        entries: row.entries,
        armored,
      });
      if (result?.ok) {
        report.sessionDays++;
        report.tokens += row.tokens;
      } else {
        ok = false;
        report.failed++;
      }
    }
    if (ok) {
      state.sessions[file] = {
        files: current.get(file),
        days,
        keys: seen.added,
        ...(armored ? { armored: true } : {}),
      };
    }
  }
  return report;
}
