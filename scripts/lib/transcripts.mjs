import { readdir, stat } from "node:fs/promises";
import path from "node:path";

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

/**
 * Sort every `.jsonl` under a Claude Code projects dir by role:
 * `main` is `<project>/<sessionId>.jsonl`, `subagent` is any other `.jsonl`
 * under `<project>/<sessionId>/subagents/`, `journal` is a workflow
 * `journal.jsonl` there, and `other` is everything else. Main transcripts are
 * ordered by creation time so an original session is read before its forks.
 */
export async function classifyTranscripts(projectsDir) {
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
  for (const file of groups.main) {
    const s = await stat(file);
    born.set(file, s.birthtimeMs || s.mtimeMs);
  }
  groups.main.sort((a, b) => born.get(a) - born.get(b) || a.localeCompare(b));
  return groups;
}
