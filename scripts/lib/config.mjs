import { homedir } from "node:os";
import path from "node:path";
import { parseBoolean, parseInteger, parseList } from "./common.mjs";

/**
 * Read a config value from CLAUDE_PLUGIN_OPTION_* (injected by Claude Code
 * plugin userConfig), falling back to the legacy ARMORCOWORK_* env var.
 */
function pluginOpt(env, pluginKey, legacyKey) {
  const pluginVal = env[`CLAUDE_PLUGIN_OPTION_${pluginKey}`]?.trim();
  if (pluginVal) return pluginVal;
  if (legacyKey) return env[legacyKey]?.trim() || "";
  return "";
}

export function loadConfig(env = process.env) {
  const mode = (pluginOpt(env, "MODE", "ARMORCOWORK_MODE") || "enforce").toLowerCase();
  const envMode = (env.ARMORIQ_ENV || "production").trim().toLowerCase();
  const useProduction = parseBoolean(
    pluginOpt(env, "USE_PRODUCTION", "ARMORCOWORK_USE_PRODUCTION") || undefined,
    envMode === "production"
  );

  // Data directory: prefer CLAUDE_PLUGIN_DATA (Claude Code injected), then
  // ARMORCOWORK_DATA_DIR, then default ~/.claude/armorcowork
  const dataDir =
    env.CLAUDE_PLUGIN_DATA?.trim() ||
    env.ARMORCOWORK_DATA_DIR?.trim() ||
    path.join(homedir(), ".claude", "armorcowork");

  const policyFile =
    env.ARMORCOWORK_POLICY_FILE?.trim() || path.join(dataDir, "policy.json");
  const runtimeFile =
    env.ARMORCOWORK_RUNTIME_FILE?.trim() || path.join(dataDir, "runtime.json");

  const timeoutMs = parseInteger(env.ARMORCOWORK_TIMEOUT_MS, 8000);

  const backendEndpoint =
    env.ARMORCOWORK_BACKEND_ENDPOINT?.trim() ||
    env.BACKEND_ENDPOINT?.trim() ||
    (useProduction
      ? "https://customer-api.armoriq.ai"
      : "http://127.0.0.1:3000");

  const iapEndpoint =
    env.ARMORCOWORK_IAP_ENDPOINT?.trim() ||
    env.IAP_ENDPOINT?.trim() ||
    (useProduction
      ? "https://customer-iap.armoriq.ai"
      : "http://127.0.0.1:8000");

  const proxyEndpoint =
    env.ARMORCOWORK_PROXY_ENDPOINT?.trim() ||
    env.PROXY_ENDPOINT?.trim() ||
    (useProduction
      ? "https://customer-proxy.armoriq.ai"
      : "http://127.0.0.1:3001");

  const csrgEndpoint =
    pluginOpt(env, "CSRG_ENDPOINT", "CSRG_URL") || iapEndpoint;

  const apiKey =
    pluginOpt(env, "API_KEY", "ARMORIQ_API_KEY");

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
    useSdkIntent: parseBoolean(env.ARMORCOWORK_USE_SDK_INTENT, true),
    intentEndpoint: env.ARMORCOWORK_INTENT_URL?.trim() || "",
    verifyStepEndpoint:
      env.ARMORCOWORK_VERIFY_STEP_URL?.trim() ||
      `${backendEndpoint}/iap/verify-step`,
    validitySeconds: parseInteger(env.ARMORCOWORK_VALIDITY_SECONDS, 60),
    timeoutMs,
    maxRetries: parseInteger(env.ARMORCOWORK_MAX_RETRIES, 3),
    verifySsl: parseBoolean(env.ARMORCOWORK_VERIFY_SSL, true),
    llmId: env.ARMORCOWORK_LLM_ID?.trim() || "claude-code",
    mcpName: env.ARMORCOWORK_MCP_NAME?.trim() || "claude-code",
    userId: env.ARMORCOWORK_USER_ID?.trim() || "claude-user",
    agentId: env.ARMORCOWORK_AGENT_ID?.trim() || "claude-code",
    contextId: env.ARMORCOWORK_CONTEXT_ID?.trim() || "default",

    // Intent enforcement — default true (enforce plan mode)
    intentRequired: parseBoolean(
      pluginOpt(env, "INTENT_REQUIRED", "ARMORCOWORK_INTENT_REQUIRED") || undefined,
      true
    ),
    requireCsrgProofs: parseBoolean(env.REQUIRE_CSRG_PROOFS, true),
    csrgVerifyEnabled: parseBoolean(env.CSRG_VERIFY_ENABLED, true),

    // Policy management
    policyUpdateEnabled: parseBoolean(env.ARMORCOWORK_POLICY_UPDATE_ENABLED, true),
    policyUpdateAllowList: parseList(
      env.ARMORCOWORK_POLICY_UPDATE_ALLOWLIST || "*"
    ),
    contextHintsEnabled: parseBoolean(
      env.ARMORCOWORK_CONTEXT_HINTS_ENABLED,
      true
    ),

    // Crypto policy binding (Merkle tree)
    cryptoPolicyEnabled: parseBoolean(
      pluginOpt(env, "CRYPTO_POLICY_ENABLED", "ARMORCOWORK_CRYPTO_POLICY_ENABLED") || undefined,
      false
    ),

    // Audit logging
    auditEnabled: parseBoolean(
      env.ARMORCOWORK_AUDIT_ENABLED,
      Boolean(apiKey)
    ),

    // Plan directive injection (tells Claude to register a plan via MCP tool)
    planningEnabled: parseBoolean(env.ARMORCOWORK_PLANNING_ENABLED, true),

    // Param sanitization limits
    sanitize: {
      maxChars: parseInteger(env.ARMORCOWORK_MAX_PARAM_CHARS, 2000),
      maxDepth: parseInteger(env.ARMORCOWORK_MAX_PARAM_DEPTH, 4),
      maxKeys: parseInteger(env.ARMORCOWORK_MAX_PARAM_KEYS, 50),
      maxItems: parseInteger(env.ARMORCOWORK_MAX_PARAM_ITEMS, 50)
    },

    debug: parseBoolean(env.ARMORCOWORK_DEBUG, false)
  };
}
