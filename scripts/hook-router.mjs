import { loadConfig } from "./lib/config.mjs";
import { denyPreTool } from "./lib/hook-output.mjs";
import {
  handlePreToolUse,
  handlePostToolUse,
  handlePostToolUseFailure,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleUserPromptExpansion,
  handleUserPromptSubmit,
} from "./lib/engine.mjs";
import { dispatchViaDaemon } from "./lib/daemon-client.mjs";
import { appendDaemonLog } from "./lib/daemon-log.mjs";
import { ensurePrivateDirSync } from "./lib/fs-store.mjs";
import { observeHook, obsFlush } from "./lib/observability.mjs";
import { launchLiveUsage } from "./lib/usage-sync-launch.mjs";
import { withReloginNotice } from "./lib/relogin.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function debugLog(config, message) {
  if (!config.debug) {
    return;
  }
  process.stderr.write(`[armorclaude] ${message}\n`);
}

const HANDLERS = {
  SessionStart: handleSessionStart,
  UserPromptSubmit: handleUserPromptSubmit,
  UserPromptExpansion: handleUserPromptExpansion,
  PreToolUse: handlePreToolUse,
  PostToolUse: handlePostToolUse,
  PostToolUseFailure: handlePostToolUseFailure,
  Stop: handleStop,
  SessionEnd: handleSessionEnd,
};

function logDaemonFallback(event, err, config) {
  const reason = err?.message ?? String(err);
  debugLog(config, `daemon dispatch failed; falling back in-process: ${reason}`);
  try {
    appendDaemonLog(
      config.dataDir,
      `[armorclaude] daemon unreachable, handling ${event} in-process pid=${process.pid} at=${new Date().toISOString()}: ${reason}`
    );
  } catch (logErr) {
    debugLog(config, `daemon.log write failed: ${logErr?.message ?? logErr}`);
  }
}

async function dispatchInDaemon(event, input, config) {
  try {
    const output = await dispatchViaDaemon({ event, input, config });
    if (output) emitJson(output);
    return true;
  } catch (err) {
    logDaemonFallback(event, err, config);
    return false;
  }
}

async function main() {
  const config = loadConfig();
  ensurePrivateDirSync(config.dataDir);
  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    return;
  }
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    // Fail-closed: a malformed hook payload on a PreToolUse looks like
    // enforcement missed, so deny in enforce mode instead of silent allow.
    // Other events just exit — they can't allow anything on their own.
    if (config.mode === "enforce") {
      emitJson(denyPreTool("invalid_payload", "ArmorClaude hook payload invalid JSON"));
    }
    return;
  }
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  debugLog(config, `hook=${event}`);

  if (config.daemonEnabled && (await dispatchInDaemon(event, input, config))) return;

  const handler = Object.hasOwn(HANDLERS, event) ? HANDLERS[event] : null;
  if (!handler) {
    debugLog(config, `unhandled hook event: ${event}`);
    return;
  }
  const output = await withReloginNotice(event, input, config, await handler(input, config));

  if (output) {
    emitJson(output);
  }
  if (event === "Stop") launchLiveUsage(config, input);

  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  await observeHook(event, input, output, config);
  await obsFlush(sessionId, config);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  let mode = "enforce";
  let debug = false;
  try {
    const config = loadConfig();
    mode = config.mode;
    debug = config.debug;
  } catch {
    // loadConfig itself threw (e.g. malformed credentials file). Stay
    // fail-closed: default to enforce rather than a silent allow.
  }
  if (debug) {
    process.stderr.write(`[armorclaude] error=${message}\n`);
  }
  if (mode === "enforce") {
    emitJson(denyPreTool("internal_error", `ArmorClaude internal error: ${message}`));
  }
});
