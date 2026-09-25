import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_MAX_BYTES = 1024 * 1024;
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "usage-sync.mjs");

/**
 * The files next to a sync state file: the lock a running sync holds and
 * the request marker a Stop touches to ask for another pass.
 */
export function syncPaths(statePath) {
  return { lock: `${statePath}.lock`, request: `${statePath}.request` };
}

export function defaultStatePath(dataDir) {
  return path.join(dataDir, "usage-sync-state.json");
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
  return env;
}

/**
 * Start scripts/usage-sync.mjs as a detached process with this config's
 * credentials and data dir, and return without waiting for it. Its stderr goes
 * to usage-sync.log in the data dir. Starts nothing while a live sync holds the
 * lock. Returns false when there is no API key or the process could not be
 * started.
 */
export function launchUsageSync(config) {
  if (!config?.apiKey) return false;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    if (lockHeld(syncPaths(defaultStatePath(config.dataDir)).lock)) return true;
    const logPath = path.join(config.dataDir, "usage-sync.log");
    const logFd = openSync(logPath, logSize(logPath) > LOG_MAX_BYTES ? "w" : "a");
    try {
      const child = spawn(process.execPath, [SCRIPT], {
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
    return true;
  } catch (err) {
    process.stderr.write(`[armorclaude] usage sync failed to start: ${err?.message ?? err}\n`);
    return false;
  }
}

/**
 * Ask for a sync pass that starts after now: touch the request marker, then
 * launch a sync unless one is running. A running sync checks the marker after
 * each pass and after releasing its lock, so it runs again instead.
 */
export function requestUsageSync(config) {
  if (!config?.apiKey) return false;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(syncPaths(defaultStatePath(config.dataDir)).request, String(Date.now()));
  } catch (err) {
    process.stderr.write(`[armorclaude] usage sync request failed: ${err?.message ?? err}\n`);
    return false;
  }
  return launchUsageSync(config);
}
