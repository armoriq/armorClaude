#!/usr/bin/env node
// Uploads token usage of the sessions this API key's organization owns, one
// row per session and UTC hour, to POST {backendEndpoint}/dashboard/token-usage.
//
//   node scripts/usage-sync.mjs [--dry-run]
//   node scripts/usage-sync.mjs --assign <project dir or session .jsonl>
//
// --dry-run : print each row instead of posting it, from its own state file.
// --assign  : give this key's organization those sessions' whole history.

import { homedir } from "node:os";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./lib/config.mjs";
import { deviceIdentity } from "./lib/device.mjs";
import {
  ensurePrivateDir,
  PRIVATE_FILE_MODE,
  writeJson,
  writePrivateFile,
} from "./lib/fs-store.mjs";
import { getSdkClient } from "./lib/intent.mjs";
import { loadRuntimeState } from "./lib/runtime-state.mjs";
import { classifyTranscripts } from "./lib/transcripts.mjs";
import {
  assignTranscripts,
  ownedTranscripts,
  resolveScope,
  scopeStatePath,
} from "./lib/usage-ownership.mjs";
import { loadSyncState, syncUsage } from "./lib/usage-sync.mjs";
import { isAlive, keySyncPaths, requestedAt, syncPaths } from "./lib/usage-sync-launch.mjs";

const BUDGET_MS = 90_000;
const HARD_STOP_MS = BUDGET_MS + 30_000;
const DEBOUNCE_MS = 2_000;

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const assignIdx = argv.indexOf("--assign");
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

async function syncPass({ config, scope, statePath, deadline }) {
  const state = await loadSyncState(statePath);
  const owned = await ownedTranscripts(config, scope, { pin: !DRY });
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
    owned,
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
      `${report.read} read, ${report.unowned} not owned by this organization; ` +
      `${verb} ${report.sessionHours} session-hour(s) ` +
      `(${report.tokens} tokens), ${report.failed} failed${why ? ` (${why})` : ""}, ` +
      `${report.left} left for the next run, ${Date.now() - started}ms`
  );
  if (report.failed) process.exitCode = 1;
}

async function transcriptsAt(target) {
  const full = path.resolve(target);
  const { main } = await classifyTranscripts(PROJECTS_DIR);
  const isDir = (await stat(full).catch(() => null))?.isDirectory();
  return main.filter((f) => (isDir ? path.dirname(f) === full : f === full));
}

async function assign(config, scope, target) {
  const transcripts = await transcriptsAt(target);
  if (!transcripts.length) {
    log(`no sessions at ${target} under ${PROJECTS_DIR}`);
    process.exitCode = 1;
    return;
  }
  const { assigned, refused } = await assignTranscripts(config, scope, transcripts);
  const why = "another organization owns it, or its owner's is not known yet";
  for (const file of refused) log(`refused ${path.basename(file, ".jsonl")}: ${why}`);
  log(
    `assigned ${assigned.length} session(s) to organization ${scope.orgId}, refused ${refused.length}`
  );
  if (refused.length) process.exitCode = 1;
}

async function scopedPass({ config, scope, deadline }) {
  const statePath = scopeStatePath(config.dataDir, scope.scopeId);
  const paths = syncPaths(statePath);
  let release = await acquireLock(paths.lock);
  if (!release) {
    await writePrivateFile(paths.request, String(Date.now()));
    release = await acquireLock(paths.lock);
    if (!release) return null;
  }
  try {
    const passStart = Date.now();
    await syncPass({ config, scope, statePath, deadline });
    return { request: paths.request, passStart };
  } finally {
    await release();
  }
}

async function runPasses(config, scope) {
  const paths = keySyncPaths(config);
  const deadline = Date.now() + BUDGET_MS;
  let passStart = -Infinity;
  const again = (ran) =>
    requestedAt(paths.request) >= passStart || (ran && requestedAt(ran.request) >= ran.passStart);
  while (Date.now() < deadline) {
    const release = await acquireLock(paths.lock);
    if (!release) {
      if (passStart === -Infinity) log("another sync for this key holds the lock, skipping");
      return;
    }
    try {
      let ran;
      do {
        await debounce(paths.request, deadline);
        passStart = Date.now();
        ran = await scopedPass({ config, scope, deadline });
      } while (again(ran) && Date.now() < deadline);
    } finally {
      await release();
    }
    if (requestedAt(paths.request) < passStart) return;
  }
}

const COMMAND = assignIdx >= 0 ? "assign" : DRY ? "dry-run" : "sync";

async function scopeOf(config) {
  try {
    return await resolveScope(config);
  } catch (err) {
    log(`nothing synced: ${err?.message ?? err}`);
    process.exitCode = 1;
    return null;
  }
}

async function sync(config, scope) {
  const hardStop = setTimeout(() => {
    log(`still running after ${HARD_STOP_MS}ms, exiting`);
    process.exit(1);
  }, HARD_STOP_MS);
  hardStop.unref();
  try {
    if (COMMAND === "sync") return await runPasses(config, scope);
    const statePath = path.join(
      path.dirname(scopeStatePath(config.dataDir, scope.scopeId)),
      "dry-run.json"
    );
    await syncPass({ config, scope, statePath, deadline: Date.now() + BUDGET_MS });
  } finally {
    clearTimeout(hardStop);
  }
}

async function main() {
  const config = loadConfig(process.env);
  if (!config.apiKey) return log("no API key, nothing synced");
  if (COMMAND === "sync" && !config.usageSyncEnabled) {
    return log(
      "usage sync is off (observability disabled or disable_usage_sync set), nothing synced"
    );
  }
  const scope = await scopeOf(config);
  if (!scope) return;
  if (COMMAND === "assign") return assign(config, scope, argv[assignIdx + 1] ?? "");
  return sync(config, scope);
}

main().catch((err) => {
  log(`fatal: ${err?.stack ?? err}`);
  process.exit(1);
});
