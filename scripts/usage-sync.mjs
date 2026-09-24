#!/usr/bin/env node
// Uploads token usage for every local Claude Code session, with or without
// ArmorClaude, one row per session-day to POST {backendEndpoint}/dashboard/token-usage.
// The daemon and the in-process SessionStart hook launch it detached; it can
// also be run by hand.
//
//   node scripts/usage-sync.mjs [--dry-run] [--state <path>]
//
// --dry-run : print each row instead of posting it. Needs no API key and keeps
//             its own state file, so it never changes what a real run posts.
// --state   : state file to read and update.

import { homedir } from "node:os";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./lib/config.mjs";
import { deviceIdentity } from "./lib/device.mjs";
import { writeJson } from "./lib/fs-store.mjs";
import { getSdkClient } from "./lib/intent.mjs";
import { loadRuntimeState } from "./lib/runtime-state.mjs";
import { loadSyncState, syncUsage } from "./lib/usage-sync.mjs";

const BUDGET_MS = 90_000;
const HARD_STOP_MS = BUDGET_MS + 30_000;

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const stateIdx = argv.indexOf("--state");
const PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

function log(message) {
  process.stderr.write(`[usage-sync] ${new Date().toISOString()} ${message}\n`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

async function acquireLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      return () => unlink(lockPath).catch(() => {});
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const owner = Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
      if (owner && isAlive(owner)) return null;
      await unlink(lockPath).catch(() => {});
    }
  }
  return null;
}

async function main() {
  const config = loadConfig(process.env);
  if (!DRY && !config.apiKey) {
    log("no API key, nothing synced");
    return;
  }
  const statePath =
    stateIdx >= 0
      ? path.resolve(argv[stateIdx + 1])
      : path.join(config.dataDir, DRY ? "usage-sync-dry-run.json" : "usage-sync-state.json");
  const release = await acquireLock(`${statePath}.lock`);
  if (!release) {
    log("another sync holds the lock, skipping");
    return;
  }
  const hardStop = setTimeout(() => {
    log(`still running after ${HARD_STOP_MS}ms, exiting`);
    process.exit(1);
  }, HARD_STOP_MS);
  hardStop.unref();
  try {
    const state = await loadSyncState(statePath);
    const runtime = await loadRuntimeState(config.runtimeFile);
    const { deviceId, deviceName } = deviceIdentity();
    const toBody = (row) => ({ product: config.productSlug, deviceId, deviceName, ...row });
    const client = DRY ? null : getSdkClient(config);
    const post = DRY
      ? async (row) => {
          process.stdout.write(`${JSON.stringify(toBody(row))}\n`);
          return { ok: true };
        }
      : (row) => client.recordTokenUsage(toBody(row));
    const started = Date.now();
    const report = await syncUsage({
      projectsDir: PROJECTS_DIR,
      state,
      post,
      isArmored: (sessionId) => Boolean(runtime.sessions[sessionId]),
      deadline: started + BUDGET_MS,
    });
    const { notRead, ...counts } = report;
    state.lastRun = { at: new Date().toISOString(), dryRun: DRY, ...counts };
    await writeJson(statePath, state);
    for (const file of notRead) log(`not read ${file}`);
    const verb = DRY ? "would post" : "posted";
    log(
      `${report.main} session(s) under ${PROJECTS_DIR} (${report.subagent} subagent, ` +
        `${report.journal} journal, ${report.other} other file(s)); ${report.changed} changed, ` +
        `${report.read} read; ${verb} ${report.sessionDays} session-day(s) ` +
        `(${report.tokens} tokens), ${report.failed} failed, ${report.left} left for the next run, ` +
        `${Date.now() - started}ms`
    );
    if (report.failed) process.exitCode = 1;
  } finally {
    clearTimeout(hardStop);
    await release();
  }
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
