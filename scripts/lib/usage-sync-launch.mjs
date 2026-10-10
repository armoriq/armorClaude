import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deviceIdentity } from "./device.mjs";
import { ensurePrivateDirSync, openPrivateSync, writePrivateFileSync } from "./fs-store.mjs";
import { isSessionId, liveDir, liveTranscript, projectsDir } from "./live-usage.mjs";
import {
  anySessionAnswers,
  endSession,
  harnessProcess,
  registerSession,
} from "./usage-sessions.mjs";

const LOG_MAX_BYTES = 1024 * 1024;
const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(SCRIPTS, "usage-sync.mjs");
const LIVE_SCRIPT = path.join(SCRIPTS, "usage-live.mjs");
const WORKER_SCRIPT = path.join(SCRIPTS, "usage-worker.mjs");

/**
 * The lock a running sync holds and the request marker a Stop touches to ask
 * for another pass. Hooks and the daemon use the data dir's pair, whichever
 * user's key is in use; the marker holds the requesting key's fingerprint.
 */
export function syncPaths(base) {
  return { lock: `${base}.lock`, request: `${base}.request` };
}

export function syncBasePath(dataDir) {
  return path.join(dataDir, "usage-sync");
}

export function keyFingerprint(apiKey) {
  return createHash("sha256")
    .update(apiKey ?? "")
    .digest("hex")
    .slice(0, 16);
}

export function userStatePath(dataDir, { backend, product, userId }) {
  const id = createHash("sha256")
    .update(JSON.stringify([backend.replace(/\/+$/, ""), product, userId]))
    .digest("hex")
    .slice(0, 32);
  return path.join(syncBasePath(dataDir), `${id}.json`);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function lockHeld(lockPath) {
  try {
    const owner = Number(readFileSync(lockPath, "utf8").trim());
    return Boolean(owner) && isAlive(owner);
  } catch {
    return false;
  }
}

/** Last time a pass was requested, in epoch ms; 0 when none was. */
export function requestedAt(requestPath) {
  try {
    return statSync(requestPath).mtimeMs;
  } catch {
    return 0;
  }
}

/** requestedAt, or 0 when the latest request came from another key. */
export function requestedFor(requestPath, fingerprint) {
  try {
    if (readFileSync(requestPath, "utf8").trim() !== fingerprint) return 0;
  } catch {
    return 0;
  }
  return requestedAt(requestPath);
}

function logSize(logPath) {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

function childEnv(config) {
  const overrides = {
    CLAUDE_PLUGIN_DATA: config.dataDir,
    ARMORCLAUDE_RUNTIME_FILE: config.runtimeFile,
    CLAUDE_PLUGIN_OPTION_API_KEY: config.apiKey,
    ARMORIQ_ENV: config.armoriqEnv,
    ARMORIQ_BACKEND_URL: config.backendEndpoint,
  };
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) if (value) env[key] = value;
  env.CLAUDE_PLUGIN_OPTION_DISABLE_OBSERVABILITY = "false";
  env.CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_SYNC = "false";
  return env;
}

/**
 * Start scripts/usage-sync.mjs as a detached process with this config's
 * credentials and data dir, and return without waiting for it. Its stderr goes
 * to usage-sync.log in the data dir. Starts nothing while a live sync holds the
 * lock. Returns false when the config disables the usage sync (no API key,
 * observability off, or `disable_usage_sync` set) or the process could not be
 * started.
 */
export function launchUsageSync(config) {
  if (!config?.usageSyncEnabled) return false;
  try {
    ensurePrivateDirSync(config.dataDir);
    if (lockHeld(syncPaths(syncBasePath(config.dataDir)).lock)) return true;
    spawnDetached(config, [SCRIPT]);
    return true;
  } catch (err) {
    process.stderr.write(`[armorclaude] usage sync failed to start: ${err?.message ?? err}\n`);
    return false;
  }
}

function spawnDetached(config, args) {
  const logPath = path.join(config.dataDir, "usage-sync.log");
  const logFd = openPrivateSync(logPath, logSize(logPath) > LOG_MAX_BYTES ? "w" : "a");
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", "ignore", logFd],
      cwd: config.dataDir,
      env: childEnv(config),
    });
    child.once("error", (err) => {
      process.stderr.write(`[armorclaude] usage sync failed to start: ${err?.message ?? err}\n`);
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

const usageDir = (config) =>
  liveDir(config.dataDir, {
    backend: config.backendEndpoint,
    product: config.productSlug,
    userId: config.userId,
    deviceId: deviceIdentity().deviceId,
  });

function ensureWorker(config, dir) {
  if (!lockHeld(path.join(dir, "worker.lock"))) spawnDetached(config, [WORKER_SCRIPT, "--serve"]);
}

async function startSession(config, sessionId) {
  const harness = harnessProcess();
  if (!harness) return;
  const dir = usageDir(config);
  await registerSession(dir, sessionId, harness);
  ensureWorker(config, dir);
}

const TRACKED = new Set(["SessionStart", "SessionEnd"]);

export async function trackUsageSession(event, input, config) {
  if (!TRACKED.has(event) || !config?.usageSyncEnabled || !isSessionId(input?.session_id)) return;
  try {
    await (event === "SessionEnd"
      ? endSession(usageDir(config), input.session_id)
      : startSession(config, input.session_id));
  } catch (err) {
    process.stderr.write(`[armorclaude] usage session tracking failed: ${err?.message ?? err}\n`);
  }
}

export function launchLiveUsage(config, input) {
  if (!config?.usageSyncEnabled) return false;
  const sessionId = input?.session_id;
  const transcript = liveTranscript(projectsDir(), sessionId, input?.transcript_path);
  if (!transcript) return false;
  try {
    const dir = usageDir(config);
    ensurePrivateDirSync(dir);
    writePrivateFileSync(path.join(dir, `${sessionId}.pending`), "");
    spawnDetached(config, [LIVE_SCRIPT, sessionId, transcript]);
    if (anySessionAnswers(dir)) ensureWorker(config, dir);
    return true;
  } catch (err) {
    process.stderr.write(`[armorclaude] usage upload failed to start: ${err?.message ?? err}\n`);
    return false;
  }
}

/**
 * Ask for a sync pass that starts after now: touch the request marker, then
 * launch a sync unless one is running. A running sync checks the marker after
 * each pass and after releasing its lock, so it runs again instead.
 */
export function requestUsageSync(config) {
  if (!config?.usageSyncEnabled) return false;
  try {
    writePrivateFileSync(
      syncPaths(syncBasePath(config.dataDir)).request,
      keyFingerprint(config.apiKey)
    );
  } catch (err) {
    process.stderr.write(`[armorclaude] usage sync request failed: ${err?.message ?? err}\n`);
    return false;
  }
  return launchUsageSync(config);
}
