import { loadConfig } from "./lib/config.mjs";
import { denyPreTool } from "./lib/hook-output.mjs";
import {
  handlePreToolUse,
  handlePostToolUse,
  handlePostToolUseFailure,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
  handleUserPromptSubmit
} from "./lib/engine.mjs";

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

async function main() {
  const config = loadConfig();
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
      emitJson(denyPreTool("ArmorClaude hook payload invalid JSON"));
    }
    return;
  }
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  debugLog(config, `hook=${event}`);

  let output;

  switch (event) {
    case "SessionStart":
      output = await handleSessionStart(input, config);
      break;
    case "UserPromptSubmit":
      output = await handleUserPromptSubmit(input, config);
      break;
    case "PreToolUse":
      output = await handlePreToolUse(input, config);
      break;
    case "PostToolUse":
      output = await handlePostToolUse(input, config);
      break;
    case "PostToolUseFailure":
      output = await handlePostToolUseFailure(input, config);
      break;
    case "Stop":
      output = await handleStop(input, config);
      break;
    case "SessionEnd":
      output = await handleSessionEnd(input, config);
      break;
    default:
      debugLog(config, `unhandled hook event: ${event}`);
      return;
  }

  if (output) {
    emitJson(output);
  }
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
    emitJson(denyPreTool(`ArmorClaude internal error: ${message}`));
  }
});
