import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOG_MAX_BYTES = 1024 * 1024;
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "usage-sync.mjs");

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
 * to usage-sync.log in the data dir. Returns false when there is no API key or
 * the process could not be started.
 */
export function launchUsageSync(config) {
  if (!config?.apiKey) return false;
  try {
    mkdirSync(config.dataDir, { recursive: true });
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
