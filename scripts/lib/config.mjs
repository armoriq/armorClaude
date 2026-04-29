import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseBoolean, parseInteger, parseList } from "./common.mjs";

/**
 * Read a config value from CLAUDE_PLUGIN_OPTION_* (injected by Claude Code
 * plugin userConfig), falling back to the legacy ARMORCLAUDE_* env var.
 */
function pluginOpt(env, pluginKey, legacyKey) {
  const pluginVal = env[`CLAUDE_PLUGIN_OPTION_${pluginKey}`]?.trim();
  if (pluginVal) return pluginVal;
  if (legacyKey) return env[legacyKey]?.trim() || "";
  return "";
}

export function loadConfig(env = process.env) {
  const mode = (pluginOpt(env, "MODE", "ARMORCLAUDE_MODE") || "enforce").toLowerCase();
  const envMode = (env.ARMORIQ_ENV || "production").trim().toLowerCase();
  const useProduction = parseBoolean(
    pluginOpt(env, "USE_PRODUCTION", "ARMORCLAUDE_USE_PRODUCTION") || undefined,
    envMode === "production"
  );

  // Data directory: prefer CLAUDE_PLUGIN_DATA (Claude Code injected), then
  // ARMORCLAUDE_DATA_DIR, then default ~/.claude/armorclaude
  const dataDir =
    env.CLAUDE_PLUGIN_DATA?.trim() ||
    env.ARMORCLAUDE_DATA_DIR?.trim() ||
    path.join(homedir(), ".claude", "armorclaude");

  const policyFile =
    env.ARMORCLAUDE_POLICY_FILE?.trim() || path.join(dataDir, "policy.json");
  const runtimeFile =
    env.ARMORCLAUDE_RUNTIME_FILE?.trim() || path.join(dataDir, "runtime.json");

  const timeoutMs = parseInteger(env.ARMORCLAUDE_TIMEOUT_MS, 8000);

  const backendEndpoint =
    env.ARMORCLAUDE_BACKEND_ENDPOINT?.trim() ||
    env.BACKEND_ENDPOINT?.trim() ||
    (useProduction
      ? "https://staging-api.armoriq.ai"
      : "http://127.0.0.1:3000");

  const iapEndpoint =
    env.ARMORCLAUDE_IAP_ENDPOINT?.trim() ||
    env.IAP_ENDPOINT?.trim() ||
    (useProduction
      ? "https://iap.armoriq.ai"
      : "http://127.0.0.1:8000");

  const proxyEndpoint =
    env.ARMORCLAUDE_PROXY_ENDPOINT?.trim() ||
    env.PROXY_ENDPOINT?.trim() ||
    (useProduction
      ? "https://cloud-run-proxy.armoriq.io"
      : "http://127.0.0.1:3001");

  const csrgEndpoint =
    pluginOpt(env, "CSRG_ENDPOINT", "CSRG_URL") || iapEndpoint;

  // API key resolution: plugin config → env var → ~/.armoriq/credentials.json
  let apiKey = pluginOpt(env, "API_KEY", "ARMORIQ_API_KEY");
  if (!apiKey) {
    try {
      const credPath = path.join(homedir(), ".armoriq", "credentials.json");
      const creds = JSON.parse(readFileSync(credPath, "utf-8"));
      if (creds?.apiKey && typeof creds.apiKey === "string") {
        apiKey = creds.apiKey;
      }
    } catch {
      // no credentials file — local-only mode
    }
  }

  return {
    mode: mode === "monitor" ? "monitor" : "enforce",
    dataDir,
    policyFile,
    runtimeFile,
    useProduction,
    backendEndpoint,
    iapEndpoint,
    proxyEndpoint,
    csrgEndpoint,
    apiKey,
    useSdkIntent: parseBoolean(env.ARMORCLAUDE_USE_SDK_INTENT, true),
    intentEndpoint: env.ARMORCLAUDE_INTENT_URL?.trim() || "",
    verifyStepEndpoint:
      env.ARMORCLAUDE_VERIFY_STEP_URL?.trim() ||
      `${backendEndpoint}/iap/verify-step`,
    // 10 minutes is long enough for multi-step agentic work without forcing
    // a replan mid-turn. Set ARMORCLAUDE_VALIDITY_SECONDS to tighten.
    validitySeconds: parseInteger(env.ARMORCLAUDE_VALIDITY_SECONDS, 600),
    // Proactively refresh the intent token when it has less than this many
    // seconds of life left, so tool calls don't hit the expiry boundary.
    refreshThresholdSeconds: parseInteger(env.ARMORCLAUDE_REFRESH_THRESHOLD_SECONDS, 30),
    timeoutMs,
    // One attempt per tool call is usually right — a hung backend shouldn't
    // stall Claude for timeout * retries. Users who really want retries can
    // opt in via ARMORCLAUDE_MAX_RETRIES.
    maxRetries: parseInteger(env.ARMORCLAUDE_MAX_RETRIES, 1),
    verifySsl: parseBoolean(env.ARMORCLAUDE_VERIFY_SSL, true),
    llmId: env.ARMORCLAUDE_LLM_ID?.trim() || "claude-code",
    mcpName: env.ARMORCLAUDE_MCP_NAME?.trim() || "claude-code",
    userId: env.ARMORCLAUDE_USER_ID?.trim() || "claude-user",
    agentId: env.ARMORCLAUDE_AGENT_ID?.trim() || "claude-code",
    contextId: env.ARMORCLAUDE_CONTEXT_ID?.trim() || "default",

    // Intent enforcement — default true (enforce plan mode)
    intentRequired: parseBoolean(
      pluginOpt(env, "INTENT_REQUIRED", "ARMORCLAUDE_INTENT_REQUIRED") || undefined,
      true
    ),
    // CSRG verification disabled by default until tenant OPA policies are
    // configured to allow Claude Code tools. The OPA default-deny behavior
    // blocks all tools when no matching policy exists. Enable once your
    // tenant has allow-rules for the tools Claude uses.
    requireCsrgProofs: parseBoolean(env.REQUIRE_CSRG_PROOFS, false),
    csrgVerifyEnabled: parseBoolean(env.CSRG_VERIFY_ENABLED, false),

    // Policy management
    policyUpdateEnabled: parseBoolean(env.ARMORCLAUDE_POLICY_UPDATE_ENABLED, true),
    policyUpdateAllowList: parseList(
      env.ARMORCLAUDE_POLICY_UPDATE_ALLOWLIST || "*"
    ),
    contextHintsEnabled: parseBoolean(
      env.ARMORCLAUDE_CONTEXT_HINTS_ENABLED,
      true
    ),

    // Crypto policy binding (Merkle tree)
    cryptoPolicyEnabled: parseBoolean(
      pluginOpt(env, "CRYPTO_POLICY_ENABLED", "ARMORCLAUDE_CRYPTO_POLICY_ENABLED") || undefined,
      false
    ),

    // Audit logging
    auditEnabled: parseBoolean(
      env.ARMORCLAUDE_AUDIT_ENABLED,
      Boolean(apiKey)
    ),

    // Plan directive injection (tells Claude to register a plan via MCP tool)
    planningEnabled: parseBoolean(env.ARMORCLAUDE_PLANNING_ENABLED, true),

    // Param sanitization limits
    sanitize: {
      maxChars: parseInteger(env.ARMORCLAUDE_MAX_PARAM_CHARS, 2000),
      maxDepth: parseInteger(env.ARMORCLAUDE_MAX_PARAM_DEPTH, 4),
      maxKeys: parseInteger(env.ARMORCLAUDE_MAX_PARAM_KEYS, 50),
      maxItems: parseInteger(env.ARMORCLAUDE_MAX_PARAM_ITEMS, 50)
    },

    debug: parseBoolean(env.ARMORCLAUDE_DEBUG, false)
  };
}
