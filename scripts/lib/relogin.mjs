import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { loginCommand } from "./config.mjs";
import { writePrivateFileSync } from "./fs-store.mjs";
import { getSession, loadRuntimeState, saveRuntimeState, upsertSession } from "./runtime-state.mjs";

export const reloginNotice = () =>
  `ArmorIQ: sign in again to keep sending armorclaude data. Run: ${loginCommand()} --force`;

function markerFile({ dataDir, observabilityEndpoint, apiKey }) {
  const binding = createHash("sha256").update(`${observabilityEndpoint}\n${apiKey}`).digest("hex");
  return path.join(dataDir, `relogin-required-${binding.slice(0, 16)}`);
}

export function markReloginRequired(config) {
  writePrivateFileSync(markerFile(config), "");
}

export function noteTokenUsageResult(config, result) {
  if (result?.reloginRequired) markReloginRequired(config);
}

async function reloginRequired(config) {
  try {
    await access(markerFile(config));
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

async function claimNotice(config, sessionId) {
  const runtimeState = await loadRuntimeState(config.runtimeFile);
  if (getSession(runtimeState, sessionId)?.reloginNoticeShown) return false;
  upsertSession(runtimeState, sessionId, { reloginNoticeShown: true });
  await saveRuntimeState(config.runtimeFile, runtimeState);
  return true;
}

export async function withReloginNotice(event, input, config, output) {
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId || event === "SessionEnd" || !config.apiKey) return output;
  if (!(await reloginRequired(config)) || !(await claimNotice(config, sessionId))) return output;
  const systemMessage = output?.systemMessage
    ? `${output.systemMessage}\n\n${reloginNotice()}`
    : reloginNotice();
  return { ...output, systemMessage };
}
