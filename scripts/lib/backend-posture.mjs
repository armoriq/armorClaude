import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeToolName, sha256Hex } from "./common.mjs";
import { writePrivateFileSync } from "./fs-store.mjs";

export const BACKEND_TIMEOUT_MS = 2_000;
export const UNREACHABLE_FOR_MS = 30_000;

const CAPABILITIES = {
  read: ["read", "glob", "grep", "ls", "notebookread"],
  write: ["write", "edit", "multiedit", "notebookedit", "apply_patch"],
  shell: ["bash", "bashoutput", "killshell", "killbash", "powershell"],
  web: ["webfetch", "websearch"],
};
const CAPABILITY_BY_TOOL = new Map(
  Object.entries(CAPABILITIES).flatMap(([capability, tools]) => tools.map((t) => [t, capability]))
);

/** The capability-table class of a tool: read, write, shell, mcp, web or other. */
export function capabilityOf(toolName) {
  const norm = normalizeToolName(toolName);
  if (norm.startsWith("mcp__")) return "mcp";
  return CAPABILITY_BY_TOOL.get(norm) ?? "other";
}

// Hooks run in short-lived processes as well as the daemon, so the posture
// lives in a file shared by both, bound to the backend and key it was seen with.
function postureFile(config) {
  return path.join(config.dataDir, "backend-posture.json");
}

function binding(config) {
  return sha256Hex(`${config.backendEndpoint}\n${config.apiKey}`).slice(0, 16);
}

function readPosture(config) {
  try {
    const posture = JSON.parse(readFileSync(postureFile(config), "utf8"));
    return posture?.binding === binding(config) ? posture : {};
  } catch {
    return {};
  }
}

function writePosture(config, posture) {
  try {
    writePrivateFileSync(
      postureFile(config),
      JSON.stringify({ binding: binding(config), ...posture })
    );
  } catch {
    // Unwritable data dir: the next call probes again.
  }
}

export function backendUnreachable(config, now = Date.now()) {
  return (readPosture(config).unreachableUntil ?? 0) > now;
}

/** The backend answered 401 for this key: the plugin runs signed out until a new login. */
export function signedOut(config) {
  return Boolean(config.apiKey) && readPosture(config).signedOut === true;
}

export function noteBackendUnreachable(config) {
  writePosture(config, { unreachableUntil: Date.now() + UNREACHABLE_FOR_MS });
}

export function noteBackendStatus(config, status) {
  if (status === 401) writePosture(config, { signedOut: true });
  else if (status >= 500) noteBackendUnreachable(config);
  else {
    const posture = readPosture(config);
    if (posture.signedOut || posture.unreachableUntil) writePosture(config, {});
  }
}
