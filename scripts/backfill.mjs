#!/usr/bin/env node
// One-shot historical token-usage backfill for ArmorClaude.
//
// Enumerates every local Claude Code session, summarizes its token usage with
// the SDK split by UTC day (main transcript plus subagent transcripts), and
// POSTs one row per session-day, with the repo and device, to
// POST {backendEndpoint}/dashboard/token-usage. One seen set spans the run, so
// history copied into a forked session is counted once.
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
// --limit N : only process the first N sessions (debugging).

import { homedir } from "node:os";
import path from "node:path";
import { sessionTranscriptPaths, summarizeSessionUsageByDay } from "@armoriq/sdk-dev";
import { loadConfig } from "./lib/config.mjs";
import { deviceIdentity } from "./lib/device.mjs";
import { classifyTranscripts } from "./lib/transcripts.mjs";

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY = args.has("--dry-run");
const COMPAT = args.has("--compat");
const ARMORED = args.has("--armored");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : Infinity;

const PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

const { deviceId, deviceName } = deviceIdentity();

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
      "[backfill] no API key. Set ARMORIQ_API_KEY or ~/.armoriq/credentials.json first."
    );
    process.exit(1);
  }
  console.error(
    `[backfill] endpoint=${config.backendEndpoint} product=${config.productSlug} ` +
      `device=${deviceName} armored=${ARMORED} compat=${COMPAT} dryRun=${DRY}`
  );

  const groups = await classifyTranscripts(PROJECTS_DIR);
  const sessions = groups.main.slice(0, LIMIT);
  const folded = new Set(groups.main.flatMap((file) => sessionTranscriptPaths(file).slice(1)));
  const orphans = groups.subagent.filter((file) => !folded.has(file));
  console.error(
    `[backfill] under ${PROJECTS_DIR}: ${groups.main.length} main, ` +
      `${groups.subagent.length} subagent, ${groups.journal.length} workflow journal, ` +
      `${groups.other.length} other transcript(s)`
  );
  console.error(
    `[backfill] reading ${sessions.length} of ${groups.main.length} session(s), subagent ` +
      `transcripts folded into their session; not read: ${groups.journal.length} journal ` +
      `(no model calls), ${orphans.length} subagent without a main transcript, ` +
      `${groups.other.length} other`
  );
  for (const file of [...orphans, ...groups.other]) console.error(`[backfill] not read ${file}`);

  const seen = new Set();
  let rows = 0;
  let tokens = 0;
  let empty = 0;
  let failed = 0;
  for (const file of sessions) {
    const sessionId = path.basename(file, ".jsonl");
    let usage;
    try {
      usage = summarizeSessionUsageByDay(file, { seen });
    } catch (e) {
      failed++;
      console.error(`[backfill] FAIL summarize ${sessionId}: ${e?.message ?? e}`);
      continue;
    }
    if (!usage.days.length) {
      empty++;
      console.error(`[backfill] skip  ${sessionId} (no usage)`);
      continue;
    }
    for (const day of usage.days) {
      const body = {
        product: config.productSlug,
        sessionId,
        usageDate: day.usageDate,
        deviceId,
        deviceName,
        armored: ARMORED,
        repo: usage.repo,
        entries: day.entries,
      };
      const dayTokens = day.entries.reduce(
        (s, e) => s + e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens,
        0
      );
      if (DRY) {
        console.log(JSON.stringify(body));
        rows++;
        tokens += dayTokens;
        continue;
      }
      try {
        const r = await post(config, body);
        if (r.ok) {
          rows++;
          tokens += dayTokens;
          console.error(
            `[backfill] ok    ${sessionId} date=${body.usageDate} models=${day.entries.length}`
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
  }
  const outcome = DRY ? `would post ${rows} session-day(s)` : `${rows} session-day(s) posted`;
  console.error(
    `[backfill] done: ${outcome} (${tokens} tokens), ${empty} no-usage, ${failed} failed, ` +
      `${sessions.length} session(s)`
  );
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(`[backfill] fatal: ${e?.stack ?? e}`);
  process.exit(1);
});
