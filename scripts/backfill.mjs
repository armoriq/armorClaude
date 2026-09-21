#!/usr/bin/env node
// One-shot historical token-usage backfill for ArmorClaude.
//
// Enumerates every local Claude Code transcript, summarizes per-session token
// usage with the SDK, derives usageDate / deviceId / repo, and POSTs one row
// per session to POST {backendEndpoint}/dashboard/token-usage (X-API-Key auth).
// This exists so usage from sessions that ran before the plugin was installed,
// or while it was disabled and later re-enabled, still shows on the dashboard
// with its real date instead of "today".
//
//   node scripts/backfill.mjs [--dry-run] [--compat] [--armored] [--limit N]
//
// --dry-run : summarize and print each body, POST nothing.
// --compat  : POST only { product, sessionId, entries }. Use this when the
//             endpoint is an older backend that rejects usageDate/deviceId/etc.
//             (loses the real date: every row lands on "today"). The current
//             dev backend accepts the full body, so omit this against dev.
// --armored : mark every backfilled row armored=true. Default false: a session
//             run without the plugin is indistinguishable after the fact, and
//             the analytics on/off filter reads a server-derived signal anyway.
// --limit N : only process the first N transcripts (debugging).

import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { summarizeTranscriptUsage } from "@armoriq/sdk-dev";
import { loadConfig } from "./lib/config.mjs";

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has("--dry-run");
const COMPAT = args.has("--compat");
const ARMORED = args.has("--armored");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : Infinity;

const PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

const deviceName = hostname();
const deviceId = "dev_" + createHash("sha256").update(deviceName).digest("hex").slice(0, 16);

async function walkJsonl(dir) {
  const out = [];
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJsonl(full)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

// Session end date (UTC) from the last line carrying a valid ISO `timestamp`.
// Token totals are cumulative, so the last line is the meaningful one; fall
// back to the file mtime when nothing parses.
function deriveUsageDate(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return fileMtimeDate(file);
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t) continue;
    try {
      const ts = JSON.parse(t)?.timestamp;
      if (typeof ts === "string") {
        const d = new Date(ts);
        if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return fileMtimeDate(file);
}

// repo = the session's cwd, read from the first line that carries one.
function deriveRepo(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const cwd = JSON.parse(t)?.cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch {
      /* skip malformed line */
    }
  }
  return undefined;
}

function fileMtimeDate(file) {
  try {
    return statSync(file).mtime.toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function post(config, body) {
  const payload = COMPAT
    ? { product: body.product, sessionId: body.sessionId, entries: body.entries }
    : body;
  const res = await fetch(`${config.backendEndpoint}/dashboard/token-usage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  return { ok: res.status < 400, status: res.status, body: text };
}

async function main() {
  const config = loadConfig(process.env);
  if (!config.apiKey) {
    console.error(
      "[backfill] no API key. Set ARMORIQ_API_KEY or ~/.armoriq/credentials.json first.",
    );
    process.exit(1);
  }
  console.error(
    `[backfill] endpoint=${config.backendEndpoint} product=${config.productSlug} ` +
      `device=${deviceName} armored=${ARMORED} compat=${COMPAT} dryRun=${DRY}`,
  );

  const files = (await walkJsonl(PROJECTS_DIR)).slice(0, LIMIT);
  console.error(`[backfill] found ${files.length} transcript(s) under ${PROJECTS_DIR}`);

  let posted = 0;
  let empty = 0;
  let failed = 0;
  for (const file of files) {
    const sessionId = path.basename(file, ".jsonl");
    let entries;
    try {
      entries = summarizeTranscriptUsage(file); // sync, reads the file itself
    } catch (e) {
      failed++;
      console.error(`[backfill] FAIL summarize ${sessionId}: ${e?.message ?? e}`);
      continue;
    }
    if (!entries.length) {
      empty++;
      console.error(`[backfill] skip  ${sessionId} (no usage)`);
      continue;
    }
    const body = {
      product: config.productSlug,
      sessionId,
      usageDate: deriveUsageDate(file),
      deviceId,
      deviceName,
      armored: ARMORED,
      repo: deriveRepo(file),
      entries,
    };
    if (DRY) {
      console.log(JSON.stringify(body));
      posted++;
      continue;
    }
    try {
      const r = await post(config, body);
      if (r.ok) {
        posted++;
        console.error(
          `[backfill] ok    ${sessionId} date=${body.usageDate} models=${entries.length}`,
        );
      } else {
        failed++;
        console.error(`[backfill] FAIL  ${sessionId} http=${r.status} ${r.body.slice(0, 200)}`);
      }
    } catch (e) {
      failed++;
      console.error(`[backfill] FAIL  ${sessionId} ${e?.message ?? e}`);
    }
  }
  console.error(
    `[backfill] done: ${posted} posted, ${empty} no-usage, ${failed} failed, ${files.length} total`,
  );
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(`[backfill] fatal: ${e?.stack ?? e}`);
  process.exit(1);
});
