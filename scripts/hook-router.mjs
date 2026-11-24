import { loadConfig } from "./lib/config.mjs";
import { denyPreTool } from "./lib/hook-output.mjs";
import { DaemonHandlerError, dispatchViaDaemon } from "./lib/daemon-client.mjs";
import { appendDaemonLog } from "./lib/daemon-log.mjs";
import { ensurePrivateDirSync } from "./lib/fs-store.mjs";
import { launchLiveUsage, trackUsageSession } from "./lib/usage-sync-launch.mjs";
import { sessionOutput } from "./lib/relogin.mjs";
import {
  claudeCodeProcessId,
  recordHookActivity,
  loadRuntimeState,
  getSession,
} from "./lib/runtime-state.mjs";
import { recordsPreToolActivity } from "./lib/hook-activity.mjs";
import {
  createAuditEnvelope,
  snapshotAuditContext,
  captureFallback,
} from "./lib/audit-capture.mjs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import path from "node:path";
import { claudeConfigDir } from "./lib/claude-paths.mjs";
import { recordCaptureFailure } from "./lib/audit-wal.mjs";

const hookContext = {};

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
  SessionStart: "handleSessionStart",
  UserPromptSubmit: "handleUserPromptSubmit",
  UserPromptExpansion: "handleUserPromptExpansion",
  PreToolUse: "handlePreToolUse",
  PostToolUse: "handlePostToolUse",
  PostToolUseFailure: "handlePostToolUseFailure",
  Stop: "handleStop",
  SessionEnd: "handleSessionEnd",
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

async function main() {
  const config = loadConfig();
  hookContext.config = config;
  ensurePrivateDirSync(config.dataDir);
  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    return;
  }
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    if (config.mode === "enforce" && !config.orgMonitor) {
      const input = { armorAudit: createAuditEnvelope() };
      hookContext.input = input;
      try {
        await captureFallback(input, config, "invalid_payload", input.armorAudit);
      } catch (error) {
        debugLog(config, `audit capture failed: ${error.message}`);
      }
      emitJson(denyPreTool("invalid_payload", "ArmorClaude hook payload invalid JSON"));
    }
    return;
  }
  hookContext.input = input;
  if (input && typeof input === "object") {
    input.armorAudit = createAuditEnvelope(input);
  }
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  debugLog(config, `hook=${event}`);
  if (Object.hasOwn(HANDLERS, event) && (event !== "PreToolUse" || recordsPreToolActivity(input))) {
    await recordHookActivity(
      input,
      config,
      event === "SessionStart" || event === "UserPromptSubmit" ? claudeCodeProcessId() : undefined
    );
  }
  await trackUsageSession(event, input, config);

  const output = await dispatchHook(event, input, config);
  if (output) emitJson(output);
}

export async function dispatchHook(event, input, config, dispatch = dispatchViaDaemon) {
  let runtimeState;
  if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(event)) {
    input.armorAudit ??= createAuditEnvelope(input);
    if (!input.armorAudit.contextCaptured) {
      runtimeState = await loadRuntimeState(config.runtimeFile);
      const session = getSession(runtimeState, input.session_id) || {};
      input.armorAudit = snapshotAuditContext(input.armorAudit, session);
    }
  }
  if (config.daemonEnabled) {
    try {
      return await dispatch({ event, input, config });
    } catch (err) {
      if (err instanceof DaemonHandlerError) throw err;
      logDaemonFallback(event, err, config);
    }
  }

  if (!Object.hasOwn(HANDLERS, event)) {
    debugLog(config, `unhandled hook event: ${event}`);
    return;
  }
  const engine = await import("./lib/engine.mjs");
  const { observeHook, obsFlush } = await import("./lib/observability.mjs");
  const handler = engine[HANDLERS[event]];
  const output = await sessionOutput(
    event,
    input,
    config,
    await handler(input, config, config.daemonEnabled ? undefined : runtimeState)
  );

  if (event === "Stop") launchLiveUsage(config, input);

  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  await observeHook(event, input, output, config);
  await obsFlush(sessionId, config);
  return output;
}

async function failedHook(error) {
  const message = error instanceof Error ? error.message : String(error);
  let mode = "enforce";
  let debug = false;
  let config = hookContext.config;
  try {
    config ??= loadConfig();
    mode = config.orgMonitor ? "monitor" : config.mode;
    debug = config.debug;
  } catch {
    // loadConfig itself threw (e.g. malformed credentials file). Stay
    // fail-closed: default to enforce rather than a silent allow.
  }
  if (debug) {
    process.stderr.write(`[armorclaude] error=${message}\n`);
  }
  if (mode === "enforce") {
    const input =
      hookContext.input && typeof hookContext.input === "object" ? hookContext.input : {};
    const dataDir =
      config?.dataDir ||
      process.env.CLAUDE_PLUGIN_DATA?.trim() ||
      process.env.ARMORCLAUDE_DATA_DIR?.trim() ||
      path.join(claudeConfigDir(process.env), "armorclaude");
    if (input.hook_event_name && input.hook_event_name !== "PreToolUse") {
      await recordCaptureFailure(dataDir, "internal_error");
      emitJson({
        systemMessage: `ArmorClaude internal error in ${input.hook_event_name}: ${message}`,
      });
      return;
    }
    try {
      await captureFallback(input, config || { dataDir }, "internal_error", input.armorAudit);
    } catch (captureError) {
      if (debug)
        process.stderr.write(`[armorclaude] audit capture failed: ${captureError.message}\n`);
    }
    emitJson(denyPreTool("internal_error", `ArmorClaude internal error: ${message}`));
  }
}

export async function runHook() {
  await main().catch(failedHook);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runHook();
}
