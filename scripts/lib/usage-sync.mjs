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

function ownedRows(usage, claim, prev) {
  const covered = usage.hours.filter((h) => !claim.since || hourKey(h) >= claim.since);
  const posted = prev?.owner === undefined ? {} : prev.hours;
  return changedHours({ hours: covered }, posted);
}

function countFailure(failures, failure) {
  const key = `${failure.status ?? ""} ${failure.reason}`;
  const known = failures.get(key);
  if (known) known.count++;
  else failures.set(key, { ...failure, count: 1 });
}

/**
 * Post the session-hours that changed since the last run, reading only sessions
 * whose main or subagent transcripts changed size or mtime, or whose owner did.
 * `owned` maps each session id this scope may post to the first UTC hour it
 * covers (null for all). Each session's entry in
 * `state.sessions` keeps the message keys it counted. The run's seen set starts
 * with the keys of every session it does not read, so a changed fork still
 * skips history it copied from an unchanged original. A session's entry is
 * replaced only when all of its changed hours posted, so a failed hour is
 * retried on the next run. `state` is updated in place.
 */
export async function syncUsage({
  projectsDir,
  state,
  owned,
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
  const ownerChanged = (f) => {
    const claim = owned.get(path.basename(f, ".jsonl"));
    return claim !== undefined && state.sessions[f]?.owner !== claim.since;
  };
  const changed = groups.main.filter(
    (f) => !sameFiles(state.sessions[f]?.files, current.get(f)) || ownerChanged(f)
  );
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
    unowned: 0,
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
    const claim = owned.get(sessionId);
    if (!claim) {
      report.unowned++;
      state.sessions[file] = { files: current.get(file), keys: seen.added };
      continue;
    }
    const prev = state.sessions[file];
    const armored = Boolean(prev?.armored) || isArmored(sessionId);
    const { hours, rows } = ownedRows(usage, claim, prev);
    let ok = true;
    let unreachable = false;
    for (const row of rows) {
      const result = await post({
        sessionId,
        usageDate: row.usageDate,
        usageHour: row.usageHour,
        repo: usage.repo,
        entries: row.entries,
        armored,
      });
      if (result?.ok) {
        report.sessionHours++;
        report.tokens += row.tokens;
        continue;
      }
      ok = false;
      report.failed++;
      unreachable = Boolean(result?.unreachable);
      countFailure(failures, {
        sessionId,
        usageDate: row.usageDate,
        usageHour: row.usageHour,
        ...(result?.status ? { status: result.status } : {}),
        ...(unreachable ? { unreachable } : {}),
        reason: result?.reason ?? "no reason given",
      });
      if (unreachable) break;
    }
    if (unreachable) {
      report.left = changed.length - i;
      break;
    }
    if (ok) {
      state.sessions[file] = {
        files: current.get(file),
        hours,
        keys: seen.added,
        owner: claim.since,
        ...(armored ? { armored: true } : {}),
      };
    }
  }
  report.failures = [...failures.values()];
  return report;
}
