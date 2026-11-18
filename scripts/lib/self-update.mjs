import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER = path.join(OWN_ROOT, "scripts", "self-update.mjs");
const MANAGED_SETTINGS = {
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
  linux: "/etc/claude-code/managed-settings.json",
  win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
}[process.platform];

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHILD_ENV = "ARMORCLAUDE_SELF_UPDATE_CHILD";
export const STATE_FILE = "self-update.json";

export async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** Claude Code installs a marketplace plugin at <config>/plugins/cache/<marketplace>/<plugin>/<version>. */
export function installedFrom(pluginRoot) {
  const parts = path.resolve(pluginRoot).split(path.sep);
  const at = parts.lastIndexOf("cache");
  if (at < 1 || parts[at - 1] !== "plugins" || parts.length !== at + 4) return null;
  return { marketplace: parts[at + 1], plugin: parts[at + 2], version: parts[at + 3] };
}

/**
 * The marketplace's autoUpdate as Claude Code resolves it: an extraKnownMarketplaces
 * entry in managed, local, project, then user settings, then known_marketplaces.json
 * (what the /plugin toggle writes). undefined means nobody chose.
 */
export async function autoUpdateSetting(
  marketplace,
  { configDir, cwd, managed = MANAGED_SETTINGS }
) {
  const settingsFiles = [
    managed,
    cwd && path.join(cwd, ".claude", "settings.local.json"),
    cwd && path.join(cwd, ".claude", "settings.json"),
    path.join(configDir, "settings.json"),
  ].filter(Boolean);
  for (const file of settingsFiles) {
    const value = (await readJsonOrNull(file))?.extraKnownMarketplaces?.[marketplace]?.autoUpdate;
    if (typeof value === "boolean") return value;
  }
  const known = await readJsonOrNull(path.join(configDir, "plugins", "known_marketplaces.json"));
  const value = known?.[marketplace]?.autoUpdate;
  return typeof value === "boolean" ? value : undefined;
}

export const pluginRef = (install) => `${install.plugin}@${install.marketplace}`;

function launchWorker(job) {
  const child = spawn(process.execPath, [WORKER, JSON.stringify(job)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

/**
 * Called from SessionStart and UserPromptSubmit. Returns the one line to show the
 * person, if any, and on SessionStart starts the daily check in a detached worker,
 * so the hook never waits on the network or on `claude plugin update`.
 */
export async function selfUpdateOnHook({
  dataDir,
  cwd,
  check,
  env = process.env,
  pluginRoot = OWN_ROOT,
  now = Date.now(),
  startWorker = launchWorker,
}) {
  try {
    if (env[CHILD_ENV] === "1") return null;
    const install = installedFrom(pluginRoot);
    if (!install || !dataDir) return null;
    const file = path.join(dataDir, STATE_FILE);
    const state = (await readJsonOrNull(file)) ?? {};
    let message = null;

    if (state.updated && !state.updated.announced) {
      message =
        install.version === state.updated.version
          ? `ArmorClaude updated to ${state.updated.version}.`
          : `ArmorClaude updated to ${state.updated.version}. Run /reload-plugins to use it.`;
      state.updated.announced = true;
    } else if (
      state.available &&
      state.available.version !== install.version &&
      state.available.noticed !== state.available.version
    ) {
      message =
        `ArmorClaude ${state.available.version} is available (you have ${install.version}). ` +
        `Update with: claude plugin update ${pluginRef(install)}`;
      state.available.noticed = state.available.version;
    }

    const due =
      check && (typeof state.checkedAt !== "number" || now - state.checkedAt >= CHECK_INTERVAL_MS);
    if (due) state.checkedAt = now;
    if (message || due) await writeJson(file, state);
    if (due) startWorker({ dataDir, pluginRoot, cwd });
    return message;
  } catch {
    return null;
  }
}

export function withNotice(result, notice) {
  if (!notice) return result;
  const shown = [result?.systemMessage, notice].filter(Boolean).join("\n\n");
  return { ...result, systemMessage: shown };
}
