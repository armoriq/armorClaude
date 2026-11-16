import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./claude-paths.mjs";

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANAGED_SETTINGS = {
  darwin: "/Library/Application Support/ClaudeCode/managed-settings.json",
  linux: "/etc/claude-code/managed-settings.json",
  win32: "C:\\Program Files\\ClaudeCode\\managed-settings.json",
}[process.platform];
const UPDATER_OFF = [
  "DISABLE_AUTOUPDATER",
  "DISABLE_UPDATES",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];

async function readJsonOrNull(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
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
 * (what the /plugin toggle writes). undefined means nobody chose, which is off for
 * a third-party marketplace.
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

export async function autoUpdateNotice({
  pluginRoot = OWN_ROOT,
  env = process.env,
  cwd,
  dataDir,
  managed,
}) {
  try {
    if (env.ARMORCLAUDE_NO_AUTO_UPDATE === "1") return null;
    if (env.FORCE_AUTOUPDATE_PLUGINS !== "1" && UPDATER_OFF.some((name) => env[name])) return null;
    const install = installedFrom(pluginRoot);
    if (!install) return null;
    const setting = await autoUpdateSetting(install.marketplace, {
      configDir: claudeConfigDir(env),
      cwd,
      ...(managed && { managed }),
    });
    if (setting !== undefined) return null;

    const marker = path.join(dataDir, "auto-update-notice-shown");
    if ((await readFile(marker, "utf8").catch(() => "")).trim() === install.version) return null;
    await mkdir(dataDir, { recursive: true });
    await writeFile(marker, install.version, { mode: 0o600 });

    return (
      `ArmorClaude does not update itself on this machine, so new releases and fixes ` +
      `will not reach you. Turn it on once: run /plugin, open Marketplaces, choose ` +
      `"${install.marketplace}", and select Enable auto-update.`
    );
  } catch {
    return null;
  }
}

export function withNotice(result, notice) {
  if (!notice) return result;
  const shown = [result?.systemMessage, notice].filter(Boolean).join("\n\n");
  return { ...result, systemMessage: shown };
}
