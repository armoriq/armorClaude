import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./lib/claude-paths.mjs";
import {
  CHILD_ENV,
  STATE_FILE,
  autoUpdateSetting,
  installedFrom,
  pluginRef,
  readJsonOrNull,
  writeJson,
} from "./lib/self-update.mjs";

const LOCK_STALE_MS = 15 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

// A hook's environment marks a running Claude Code session; a `claude` started
// with it would act as part of that session instead of a plain CLI call.
const SESSION_ENV =
  /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PLUGIN_.*|CLAUDE_PROJECT_DIR|CLAUDE_ENV_FILE)$/;

export function cleanEnv(env) {
  const out = Object.fromEntries(Object.entries(env).filter(([key]) => !SESSION_ENV.test(key)));
  out[CHILD_ENV] = "1";
  return out;
}

export function isNewer(latest, installed) {
  const parse = (v) =>
    String(v)
      .split(".")
      .map((n) => Number.parseInt(n, 10));
  const [a, b] = [parse(latest), parse(installed)];
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

function gitUrl(source) {
  if (source?.source === "github" && source.repo) return `https://github.com/${source.repo}.git`;
  if ((source?.source === "url" || source?.source === "git") && source.url) return source.url;
  return null;
}

function latestCommit(source, env) {
  const url = gitUrl(source);
  if (!url) return null;
  const ref = source.ref ? `refs/heads/${source.ref}` : "HEAD";
  const out = spawnSync("git", ["ls-remote", url, ref], {
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
  });
  const sha = out.status === 0 ? out.stdout.split(/\s/)[0] : "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 12) : null;
}

export async function runSelfUpdate({ pluginRoot, cwd }, env = process.env, log = () => {}) {
  const install = installedFrom(pluginRoot);
  if (!install) return { result: "not-a-marketplace-install" };
  const configDir = claudeConfigDir(env);
  const childEnv = cleanEnv(env);
  const claude = (args) => {
    const out = spawnSync("claude", args, {
      env: childEnv,
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    log(
      `claude ${args.join(" ")} -> ${out.status ?? out.error?.code}: ${(out.stdout + out.stderr).trim().slice(-300)}`
    );
    return out.status === 0;
  };

  claude(["plugin", "marketplace", "update", install.marketplace]);
  const known = await readJsonOrNull(path.join(configDir, "plugins", "known_marketplaces.json"));
  const location = known?.[install.marketplace]?.installLocation;
  const catalog = location
    ? await readJsonOrNull(path.join(location, ".claude-plugin", "marketplace.json"))
    : null;
  const entry = catalog?.plugins?.find((p) => p.name === install.plugin);
  if (!entry) return { result: "no-catalog-entry" };

  const latest = entry.version ?? latestCommit(entry.source, childEnv);
  if (!latest) return { result: "no-latest-version" };
  const newer = entry.version ? isNewer(latest, install.version) : latest !== install.version;
  if (!newer) return { result: "current", latest };

  const optedOut =
    env.ARMORCLAUDE_NO_AUTO_UPDATE === "1" ||
    (await autoUpdateSetting(install.marketplace, { configDir, cwd })) === false;
  if (optedOut) return { result: "available", latest };

  if (!claude(["plugin", "update", pluginRef(install)])) return { result: "failed", latest };
  const installed = await readJsonOrNull(path.join(configDir, "plugins", "installed_plugins.json"));
  const record = installed?.plugins?.[pluginRef(install)]?.[0];
  if (!record?.version || record.version === install.version) return { result: "failed", latest };
  if (record.installPath) {
    // Otherwise the new version's first hook runs npm install and holds up that session.
    const warm = spawnSync(
      process.execPath,
      [path.join(record.installPath, "scripts", "bootstrap.mjs"), "warm"],
      {
        env: childEnv,
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
      }
    );
    log(`warm ${record.installPath} -> ${warm.status ?? warm.error?.code}`);
  }
  return { result: "updated", latest, version: record.version };
}

function takeLock(file) {
  try {
    if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) unlinkSync(file);
  } catch {
    // no lock yet
  }
  try {
    closeSync(openSync(file, "wx"));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const job = JSON.parse(process.argv[2] ?? "{}");
  if (!job.dataDir) return;
  mkdirSync(job.dataDir, { recursive: true });
  const lock = path.join(job.dataDir, "self-update.lock");
  if (!takeLock(lock)) return;
  const logFile = path.join(job.dataDir, "self-update.log");
  const log = (line) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // logging must never stop the update
    }
  };
  try {
    const outcome = await runSelfUpdate(job, process.env, log);
    log(`result ${JSON.stringify(outcome)}`);
    const file = path.join(job.dataDir, STATE_FILE);
    const state = (await readJsonOrNull(file)) ?? {};
    if (outcome.result === "updated") {
      state.updated = { version: outcome.version, at: new Date().toISOString(), announced: false };
      delete state.available;
    } else if (outcome.result === "available") {
      state.available = { version: outcome.latest, noticed: state.available?.noticed };
    }
    state.lastResult = outcome.result;
    await writeJson(file, state);
  } catch (error) {
    log(`error ${error?.message ?? error}`);
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone; a stale lock expires anyway
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
