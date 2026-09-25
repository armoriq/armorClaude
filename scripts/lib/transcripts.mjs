import { createReadStream } from "node:fs";
import { readdir, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

async function walkJsonl(dir) {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJsonl(full)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// Copied lines keep their original timestamps, so a fork and its original start
// at the same instant. Skip lines marked as copied or stamped with another
// session's id and take the first line the session wrote itself.
async function firstOwnTimestampMs(file, sessionId) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let first = Infinity;
  try {
    for await (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const ms = typeof obj?.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
      if (Number.isNaN(ms)) continue;
      if (first === Infinity) first = ms;
      const copied =
        obj.forkedFrom || (typeof obj.sessionId === "string" && obj.sessionId !== sessionId);
      if (!copied) return ms;
    }
  } catch {
    // Unreadable: keep whatever was found; path order breaks the tie.
  } finally {
    lines.close();
    input.destroy();
  }
  return first;
}

// Where birthtime is 0 (some Linux filesystems), mtime is not a substitute: a
// still-growing original would sort after its fork and lose its copied history.
async function createdMs(file, stat) {
  const { birthtimeMs } = await stat(file);
  return birthtimeMs || firstOwnTimestampMs(file, path.basename(file, ".jsonl"));
}

/**
 * Sort every `.jsonl` under a Claude Code projects dir by role:
 * `main` is `<project>/<sessionId>.jsonl`, `subagent` is any other `.jsonl`
 * under `<project>/<sessionId>/subagents/`, `journal` is a workflow
 * `journal.jsonl` there, and `other` is everything else. Main transcripts are
 * ordered by creation time, or where the filesystem has no birthtime by the
 * first line the session wrote itself, so an original is read before its forks.
 */
export async function classifyTranscripts(projectsDir, { stat = fsStat } = {}) {
  const groups = { main: [], subagent: [], journal: [], other: [] };
  for (const file of await walkJsonl(projectsDir)) {
    const parts = path.relative(projectsDir, file).split(path.sep);
    if (parts.length === 2 && SESSION_FILE.test(parts[1])) groups.main.push(file);
    else if (parts.length >= 4 && parts[2] === "subagents") {
      const isJournal = parts[3] === "workflows" && parts[parts.length - 1] === "journal.jsonl";
      groups[isJournal ? "journal" : "subagent"].push(file);
    } else groups.other.push(file);
  }
  const born = new Map();
  for (const file of groups.main) born.set(file, await createdMs(file, stat));
  groups.main.sort((a, b) => born.get(a) - born.get(b) || a.localeCompare(b));
  return groups;
}
