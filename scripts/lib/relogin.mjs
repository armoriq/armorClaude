import armoriqSdk from "@armoriq/sdk-dev";
import { createHash } from "node:crypto";
import { access, rm } from "node:fs/promises";
import path from "node:path";
import { writePrivateFile } from "./fs-store.mjs";
import { getSession, loadRuntimeState, saveRuntimeState, upsertSession } from "./runtime-state.mjs";

const { isReloginRequired } = armoriqSdk;

export const RELOGIN_NOTICE =
  "ArmorIQ: sign in again to keep sending armorclaude data. Run: armoriq login --product armorclaude --force";

function markerFile({ dataDir, observabilityEndpoint, apiKey }) {
  const binding = createHash("sha256").update(`${observabilityEndpoint}\n${apiKey}`).digest("hex");
  return path.join(dataDir, `relogin-required-${binding.slice(0, 16)}`);
}

export async function noteTelemetryAnswer(config, status, body) {
  if (isReloginRequired(status, body)) await writePrivateFile(markerFile(config), "");
  else if (status < 400) await rm(markerFile(config), { force: true });
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
    ? `${output.systemMessage}\n\n${RELOGIN_NOTICE}`
    : RELOGIN_NOTICE;
  return { ...output, systemMessage };
}
