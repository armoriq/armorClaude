import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDir, writePrivateFile } from "./fs-store.mjs";

const ORG_MODES = new Set(["shadow", "enforce"]);

const modeFile = (dataDir) => path.join(dataDir, "org-mode.json");

function cachedOrg(dataDir) {
  try {
    const { mode, notices } = JSON.parse(readFileSync(modeFile(dataDir), "utf8"));
    return { mode: ORG_MODES.has(mode) ? mode : null, notices: notices === true };
  } catch {
    return { mode: null, notices: false };
  }
}

const cachedOrgMode = (dataDir) => cachedOrg(dataDir).mode;

export const orgModeForced = (env = process.env) => env.ARMORIQ_ORG_MODE?.trim() === "enforce";

export function orgMonitorFor(dataDir, env = process.env) {
  if (orgModeForced(env)) return false;
  return cachedOrgMode(dataDir) !== "enforce";
}

/** Monitor that also tells the user in the chat what Enforce would have done. */
export const orgMonitorNoticesFor = (dataDir, env = process.env) =>
  orgMonitorFor(dataDir, env) && cachedOrg(dataDir).notices;

/** A session start fetches the org's mode after its config was read, and applies it at once. */
export function monitorAfterFetch(config) {
  const fetched = cachedOrgMode(config.dataDir);
  if (config.unconfigured || config.orgModeForced || !fetched) return Boolean(config.orgMonitor);
  return fetched !== "enforce";
}

export async function saveOrgMode(dataDir, mode, notices = false) {
  if (!ORG_MODES.has(mode)) return;
  const at = new Date().toISOString();
  await writePrivateFile(
    modeFile(dataDir),
    JSON.stringify({ mode, notices: notices === true, at })
  );
}

const hash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
const sessionDir = (dataDir, sessionId) => path.join(dataDir, "would-be", hash(sessionId));

function callKey(input) {
  if (typeof input.tool_use_id === "string" && input.tool_use_id) return input.tool_use_id;
  return `${input.tool_name ?? ""}`;
}

const verdictFile = (dataDir, input) =>
  path.join(sessionDir(dataDir, input.session_id ?? ""), `${hash(callKey(input))}.json`);

export async function rememberWouldBe(dataDir, input, verdict) {
  await ensurePrivateDir(sessionDir(dataDir, input.session_id ?? ""));
  await writePrivateFile(verdictFile(dataDir, input), JSON.stringify(verdict));
}

export async function takeWouldBe(dataDir, input) {
  const file = verdictFile(dataDir, input);
  try {
    const verdict = JSON.parse(await readFile(file, "utf8"));
    await rm(file, { force: true });
    return verdict;
  } catch {
    return null;
  }
}

/** A call the user refused in Claude Code's own prompt never reaches PostToolUse. */
export async function dropWouldBe(dataDir, sessionId) {
  await rm(sessionDir(dataDir, sessionId), { recursive: true, force: true });
}
