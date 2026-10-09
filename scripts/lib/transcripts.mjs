import { createReadStream, readFileSync } from "node:fs";
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

const isCopied = (obj, sessionId) =>
  Boolean(obj.forkedFrom) || (typeof obj.sessionId === "string" && obj.sessionId !== sessionId);

/**
 * Message keys (`<message id>:<request id>`, the key summarizeSessionUsageByHour
 * dedupes on) of the lines a session's main transcript copied from another one.
 */
export function copiedMessageKeys(file, sessionId) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const keys = [];
  for (const line of raw.split("\n")) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const id = obj?.message?.id;
    if (typeof id === "string" && isCopied(obj, sessionId))
      keys.push(`${id}:${obj.requestId ?? ""}`);
  }
  return keys;
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
      if (!isCopied(obj, sessionId)) return ms;
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

const tokenCount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const firstObject = (...values) =>
  values.find((v) => v !== null && typeof v === "object" && Object.keys(v).length > 0);

function lineTime(timestamp) {
  if (typeof timestamp !== "string" || !timestamp) return undefined;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp.trim()) || !timestamp.includes("T");
  const ms = Date.parse(zoned ? timestamp : `${timestamp}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

function readLines(file) {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return line.trim() ? [JSON.parse(line)] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function usageLine(obj) {
  const msg = firstObject(obj?.message, obj?.payload) ?? obj;
  const usage = msg?.usage ?? obj?.usage;
  const model =
    typeof msg?.model === "string" ? msg.model : typeof obj?.model === "string" ? obj.model : "";
  if (!usage || !model || model === "<synthetic>") return null;
  const entry = {
    model,
    inputTokens: tokenCount(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: tokenCount(usage.output_tokens ?? usage.completion_tokens),
    cacheReadTokens: tokenCount(
      usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens
    ),
    cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
  };
  const id = typeof msg?.id === "string" ? msg.id : "";
  const key = id ? `${id}:${typeof obj?.requestId === "string" ? obj.requestId : ""}` : null;
  return { key, entry };
}

/**
 * The usage in a session's transcripts (main and subagents) that `owns`
 * rejects, read the way summarizeSessionUsageByHour reads it: keyed messages
 * as keys to skip, and lines without a message id as per-hour entries to
 * subtract, since the summary counts every such line. A line with no
 * timestamp takes the previous line's time in its file; lines before a
 * file's first timestamp take the session's earliest time.
 */
export function foreignUsage(paths, owns, now = Date.now()) {
  const files = paths.map(readLines);
  const times = files.flatMap((lines) =>
    lines.map((o) => lineTime(o?.timestamp)).filter((t) => t !== undefined)
  );
  const earliest = times.length ? Math.min(...times) : now;
  const keys = new Set();
  const keyless = [];
  for (const lines of files) {
    let last;
    for (const obj of lines) {
      last = lineTime(obj?.timestamp) ?? last;
      const usage = usageLine(obj);
      if (!usage || owns(last ?? earliest)) continue;
      if (usage.key) keys.add(usage.key);
      else
        keyless.push({
          hour: last === undefined ? null : new Date(last).toISOString().slice(0, 13),
          ...usage.entry,
        });
    }
  }
  return { keys: [...keys], keyless };
}
