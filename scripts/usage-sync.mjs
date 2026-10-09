#!/usr/bin/env node
// Uploads token usage for every local Claude Code session, with or without
// ArmorClaude, one row per session and UTC hour to POST {backendEndpoint}/dashboard/token-usage.
// It is the only writer of those rows. The daemon launches it every 10 minutes
// and after each Stop, the in-process hook path on SessionStart and Stop; it
// can also be run by hand.
//
//   node scripts/usage-sync.mjs [--dry-run] [--state <path>]
//
// --dry-run : print each row instead of posting it. Needs no API key, ignores
//             the observability and usage sync switches, and keeps its own
//             state file, so it never changes what a real run posts.
// --state   : state file to read and update. Without it, each API key's user
//             keeps its own state per backend and product.

import { homedir } from "node:os";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { keyOwner } from "./lib/backend-client.mjs";
import { loadConfig } from "./lib/config.mjs";
import { deviceIdentity } from "./lib/device.mjs";
import { ensurePrivateDir, PRIVATE_FILE_MODE, writeJson } from "./lib/fs-store.mjs";
import { getSdkClient } from "./lib/intent.mjs";
import { noteTokenUsageResult, RELOGIN_NOTICE } from "./lib/relogin.mjs";
import { loadRuntimeState } from "./lib/runtime-state.mjs";
import { loadSyncState, syncUsage } from "./lib/usage-sync.mjs";
import {
  isAlive,
  keyFingerprint,
  requestedAt,
  requestedFor,
  switchWindow,
  syncBasePath,
  syncPaths,
  userStatePath,
} from "./lib/usage-sync-launch.mjs";

const BUDGET_MS = 90_000;
const HARD_STOP_MS = BUDGET_MS + 30_000;
const DEBOUNCE_MS = 2_000;

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const stateIdx = argv.indexOf("--state");
const PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

function log(message) {
  process.stderr.write(`[usage-sync] ${new Date().toISOString()} ${message}\n`);
}

function failureReason(f, backendEndpoint) {
  if (f.unreachable)
    return `backend unreachable at ${new URL(backendEndpoint).origin}: ${f.reason}`;
  return f.status ? `HTTP ${f.status}: ${f.reason}` : f.reason;
}

function failedAt(f) {
  if (f.usageDate === undefined) return `session ${f.sessionId}`;
  const hour = String(f.usageHour).padStart(2, "0");
  return `session ${f.sessionId} ${f.usageDate} ${hour}:00 UTC`;
}

async function acquireLock(lockPath) {
  await ensurePrivateDir(path.dirname(lockPath));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: PRIVATE_FILE_MODE });
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

// Stops that land within DEBOUNCE_MS of the latest request share one pass.
async function debounce(requestPath, deadline) {
  const wait = Math.min(requestedAt(requestPath) + DEBOUNCE_MS, deadline) - Date.now();
  if (wait > 0) await sleep(wait);
}

async function ownStatePath(config) {
  const owner = await keyOwner(config);
  if (!owner.ok) {
    log(`could not resolve the API key's user (${owner.reason}), nothing synced`);
    return null;
  }
  return userStatePath(config.dataDir, {
    backend: config.backendEndpoint,
    product: config.productSlug,
    userId: owner.userId,
  });
}

async function chooseStatePath(config) {
  if (stateIdx >= 0) return { statePath: path.resolve(argv[stateIdx + 1]), fixed: true };
  if (DRY) return { statePath: path.join(config.dataDir, "usage-sync-dry-run.json"), fixed: true };
  const statePath = await ownStatePath(config);
  const skip = statePath && switchWindow(statePath);
  if (!skip) return { statePath, fixed: false };
  log(
    skip.after
      ? `another user synced from this data dir since ${skip.after}:00 UTC, skipping the hours in between`
      : `another user synced from this data dir, uploading from ${skip.before}:00 UTC on`
  );
  return { statePath, fixed: false, skip };
}

async function syncPass({ config, statePath, skip, deadline }) {
  await ensurePrivateDir(path.dirname(statePath));
  const state = await loadSyncState(statePath, { skip });
  const runtime = await loadRuntimeState(config.runtimeFile);
  const { deviceId, deviceName } = deviceIdentity();
  const toBody = (row) => ({ product: config.productSlug, deviceId, deviceName, ...row });
  const client = DRY ? null : getSdkClient(config);
  const post = DRY
    ? async (row) => {
        process.stdout.write(`${JSON.stringify(toBody(row))}\n`);
        return { ok: true };
      }
    : async (row) => {
        const result = await client.recordTokenUsage(toBody(row));
        noteTokenUsageResult(config, result);
        return result;
      };
  const started = Date.now();
  const report = await syncUsage({
    projectsDir: PROJECTS_DIR,
    state,
    post,
    isArmored: (sessionId) => Boolean(runtime.sessions[sessionId]),
    deadline,
  });
  const { notRead, ...counts } = report;
  state.lastRun = { at: new Date().toISOString(), dryRun: DRY, ...counts };
  await writeJson(statePath, state);
  for (const file of notRead) log(`not read ${file}`);
  const reason = (f) => failureReason(f, config.backendEndpoint);
  for (const f of report.failures) {
    log(`failed ${f.count}x, first at ${failedAt(f)}: ${reason(f)}`);
  }
  const verb = DRY ? "would post" : "posted";
  const why = report.failures.map((f) => `${f.count}x ${reason(f)}`).join("; ");
  log(
    `${report.main} session(s) under ${PROJECTS_DIR} (${report.subagent} subagent, ` +
      `${report.journal} journal, ${report.other} other file(s)); ${report.changed} changed, ` +
      `${report.read} read; ${verb} ${report.sessionHours} session-hour(s) ` +
      `(${report.tokens} tokens), ${report.failed} failed${why ? ` (${why})` : ""}, ` +
      `${report.left} left for the next run, ${Date.now() - started}ms`
  );
  if (report.reloginRequired) log(RELOGIN_NOTICE);
  if (report.failed) process.exitCode = 1;
}

async function runPasses({ config, statePath, skip, paths, deadline }) {
  const mine = keyFingerprint(config.apiKey);
  let passStart = -Infinity;
  // A Stop can touch the request marker after the last pass began but see
  // the lock still held, so the marker is checked again once it is released.
  while (Date.now() < deadline) {
    const release = await acquireLock(paths.lock);
    if (!release) {
      if (passStart === -Infinity) log("another sync holds the lock, skipping");
      return;
    }
    try {
      do {
        await debounce(paths.request, deadline);
        passStart = Date.now();
        await syncPass({ config, statePath, skip, deadline });
      } while (requestedFor(paths.request, mine) >= passStart && Date.now() < deadline);
    } finally {
      await release();
    }
    if (requestedFor(paths.request, mine) < passStart) {
      if (requestedAt(paths.request) >= passStart) log("a pass was requested for another API key");
      return;
    }
  }
}

async function main() {
  const config = loadConfig(process.env);
  if (!DRY && !config.apiKey) {
    log("no API key, nothing synced");
    return;
  }
  if (!DRY && !config.usageSyncEnabled) {
    log("usage sync is off (observability disabled or disable_usage_sync set), nothing synced");
    return;
  }
  const { statePath, fixed, skip } = await chooseStatePath(config);
  if (!statePath) {
    process.exitCode = 1;
    return;
  }
  const paths = syncPaths(fixed ? statePath : syncBasePath(config.dataDir));
  const deadline = Date.now() + BUDGET_MS;
  const hardStop = setTimeout(() => {
    log(`still running after ${HARD_STOP_MS}ms, exiting`);
    process.exit(1);
  }, HARD_STOP_MS);
  hardStop.unref();
  try {
    await runPasses({ config, statePath, skip, paths, deadline });
  } finally {
    clearTimeout(hardStop);
  }
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
