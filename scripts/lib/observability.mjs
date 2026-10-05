import armoriqSdk from "@armoriq/sdk-dev";
import { sanitizeParams, redactSecrets } from "./common.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;

const sessions = new Map();

let testHooks = null;

async function safeObsAsync(fn) {
  try {
    return await fn();
  } catch (err) {
    if (process.env.ARMORCLAUDE_DEBUG) {
      process.stderr.write(`[armorclaude-obs] ${err?.message ?? err}\n`);
    }
    return undefined;
  }
}

export function isObsEnabled(config) {
  return Boolean(config && config.observabilityEnabled);
}

function getOrInitEntry(sessionId, config) {
  let entry = sessions.get(sessionId);
  if (entry) return Promise.resolve(entry);
  return initEntry(sessionId, config);
}

async function settledWithin(ms, promise) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(resolve, ms).unref();
  });
  try {
    return await Promise.race([promise.catch(() => undefined), expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function initEntry(sessionId, config) {
  const sdkVersion = typeof armoriqSdk.VERSION === "string" ? armoriqSdk.VERSION : "unknown";
  const runtimeOptions = {
    backendEndpoint: config.observabilityEndpoint,
    apiKey: config.apiKey,
    sdkVersion,
    options: { serviceName: config.observabilityProduct || "armorclaude" },
  };
  if (testHooks?.leaseFetcher) runtimeOptions.leaseFetcher = testHooks.leaseFetcher;
  if (testHooks?.tracerProvider) {
    runtimeOptions.options = {
      ...runtimeOptions.options,
      exporter: "provider",
      tracerProvider: testHooks.tracerProvider,
    };
  }
  const runtime = new ArmorIQTelemetryRuntime(runtimeOptions);
  const session = new OtelSession(runtime, {
    sessionId,
    agentId: config.agentId || null,
    userId: config.userId || null,
  });
  const entry = { runtime, session };
  sessions.set(sessionId, entry);
  await settledWithin(500, session.refreshPolicy());
  return entry;
}

export function __resetObsForTests() {
  sessions.clear();
}

export function __setOtelTestHooksForTests(hooks) {
  testHooks = hooks || null;
}

function classifyDecision(output) {
  const d = output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision;
  if (d === "deny") return "block";
  if (d === "ask") return "hold";
  return "allow";
}

function operationCategory(toolName) {
  return typeof toolName === "string" && toolName.startsWith("mcp__") ? "mcp" : "tool";
}

async function obsStartPlan(sessionId, config, prompt) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    const { prompt: sanitizedInput } = sanitizeParams({ prompt }, config.sanitize);
    await entry.session.beginRoot({ input: sanitizedInput ?? null });
  });
}

async function obsCheck(sessionId, config, toolName, toolInput, output) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    const reason =
      (output && output.hookSpecificOutput && output.hookSpecificOutput.permissionDecisionReason) ||
      undefined;
    await entry.session.recordPolicy(
      { toolName, arguments: sanitizeParams(toolInput, config.sanitize) },
      { decision: classifyDecision(output), ...(reason ? { policyReasonCode: reason } : {}) }
    );
  });
}

async function obsReport(sessionId, config, toolName, toolInput, toolResponse, outcome) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    await entry.session.recordTool(
      {
        toolName,
        arguments: sanitizeParams(toolInput, config.sanitize),
        operation: { category: operationCategory(toolName) },
      },
      {
        outcome,
        result: redactSecrets(sanitizeParams(toolResponse, config.sanitize)),
      }
    );
  });
}

// Only structured expansion events confirm command activity. Keep the label
// bounded and reject arguments rather than treating arbitrary prompt text as
// execution evidence.
function expandedSlashCommand(input) {
  if (input.expansion_type !== "slash_command" || typeof input.command_name !== "string") {
    return null;
  }
  const name = input.command_name.trim();
  const command = name.startsWith("/") ? name : `/${name}`;
  if (
    command.length <= 1 ||
    command.length > 80 ||
    command.startsWith("//") ||
    /\s/.test(command)
  ) {
    return null;
  }
  return command;
}

// The SDK accepts only tool names that start alphanumeric.
async function obsSlashCommand(sessionId, config, command) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    await entry.session.recordOperation({
      category: "command",
      name: "command.execute",
      toolName: command.replace(/^\//, ""),
    });
  });
}

async function obsConnected(sessionId, config) {
  const entry = await getOrInitEntry(sessionId, config);
  return safeObsAsync(async () => {
    await entry.session.beginRoot({
      input: `ArmorClaude connected (${config.observabilityProduct || "armorclaude"})`,
    });
  });
}

async function obsEndTurn(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  await safeObsAsync(() => entry.session.flush("ok"));
}

async function obsEndSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  await safeObsAsync(() => entry.session.close("ok"));
}

export async function obsFlushAll() {
  for (const entry of sessions.values()) {
    await safeObsAsync(() => entry.runtime.forceFlush());
  }
}

export async function observeHook(event, input, output, config) {
  if (!isObsEnabled(config)) return;
  const sessionId = typeof input?.session_id === "string" ? input.session_id : "";
  if (!sessionId) return;
  await safeObsAsync(async () => {
    switch (event) {
      case "SessionStart":
        // "ArmorClaude connected to Claude" — one connect record per session.
        await obsConnected(sessionId, config);
        break;
      case "UserPromptSubmit": {
        const prompt = typeof input.prompt === "string" ? input.prompt : "";
        await obsStartPlan(sessionId, config, prompt);
        break;
      }
      case "UserPromptExpansion": {
        const slash = expandedSlashCommand(input);
        if (slash) await obsSlashCommand(sessionId, config, slash);
        break;
      }
      case "PreToolUse":
        await obsCheck(
          sessionId,
          config,
          typeof input.tool_name === "string" ? input.tool_name : "",
          input.tool_input,
          output
        );
        break;
      case "PostToolUse":
        await obsReport(
          sessionId,
          config,
          input.tool_name,
          input.tool_input,
          input.tool_response,
          "success"
        );
        break;
      case "PostToolUseFailure":
        await obsReport(
          sessionId,
          config,
          input.tool_name,
          input.tool_input,
          input.tool_response,
          "error"
        );
        break;
      case "Stop":
        await obsEndTurn(sessionId);
        break;
      case "SessionEnd":
        await obsEndSession(sessionId);
        break;
      default:
        break;
    }
  });
}

export async function obsFlush(sessionId, config) {
  if (!isObsEnabled(config)) return;
  const entry = sessions.get(sessionId);
  if (!entry) return;
  await safeObsAsync(() => entry.runtime.forceFlush());
}
