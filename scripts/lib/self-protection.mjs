import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "./claude-paths.mjs";
import { isPlainObject } from "./common.mjs";
import { isProtectedPath } from "./shell-guard.mjs";

const HOOK_KEYS = ["hooks", "disableAllHooks", "enabledPlugins", "allowManagedHooksOnly"];
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function protectedPaths(config, cwd, env = process.env) {
  const claudeDir = claudeConfigDir(env);
  const state = [
    config.dataDir,
    config.policyFile,
    config.runtimeFile,
    path.join(homedir(), ".armoriq"),
    path.join(homedir(), ".armoriq", "credentials.json"),
    ...(isProtectedPath(pluginRoot, [path.join(claudeDir, "plugins")]) ? [pluginRoot] : []),
  ];
  const projects = [];
  for (let dir = cwd; dir; dir = path.dirname(dir) === dir ? null : path.dirname(dir)) {
    if (dir === cwd || existsSync(path.join(dir, ".claude"))) projects.push(dir);
  }
  return {
    state,
    userSettings: path.join(claudeDir, "settings.json"),
    projectSettings: projects.flatMap((dir) =>
      ["settings.json", "settings.local.json"].map((f) => path.join(dir, ".claude", f))
    ),
    markers: [".armoriq", path.basename(config.dataDir)],
  };
}

function applyEdit(text, edit) {
  if (typeof text !== "string" || !isPlainObject(edit)) return null;
  const { old_string: from, new_string: to, replace_all: all } = edit;
  if (typeof from !== "string" || typeof to !== "string" || !text.includes(from)) return null;
  return all ? text.split(from).join(to) : text.replace(from, () => to);
}

function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function settingsAfter(file, norm, input) {
  const before = readText(file);
  if (norm === "write") return [before, typeof input?.content === "string" ? input.content : null];
  if (norm === "edit") return [before, applyEdit(before, input)];
  if (norm === "multiedit" && Array.isArray(input?.edits))
    return [before, input.edits.reduce(applyEdit, before)];
  return [before, null];
}

function parseSettings(text) {
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function changesHookSettings(file, norm, input) {
  const [before, after] = settingsAfter(file, norm, input);
  const next = after === null ? null : parseSettings(after);
  if (!next) return true;
  const current = parseSettings(before) ?? {};
  return HOOK_KEYS.some((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
}
