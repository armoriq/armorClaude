import { loadConfig } from "./lib/config.mjs";
import { denyPreTool } from "./lib/hook-output.mjs";
import { handlePreToolUse, handleUserPromptSubmit } from "./lib/engine.mjs";

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
  process.stderr.write(`[armorcowork] ${message}\n`);
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
    return;
  }
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  debugLog(config, `hook=${event}`);

  if (event === "UserPromptSubmit") {
    const output = await handleUserPromptSubmit(input, config);
    if (output) {
      emitJson(output);
    }
    return;
  }

  if (event === "PreToolUse") {
    const output = await handlePreToolUse(input, config);
    if (output) {
      emitJson(output);
    }
  }
}

main().catch((error) => {
  const config = loadConfig();
  const message = error instanceof Error ? error.message : String(error);
  debugLog(config, `error=${message}`);
  if (config.mode === "enforce") {
    emitJson(denyPreTool(`ArmorCowork internal error: ${message}`));
  }
});

