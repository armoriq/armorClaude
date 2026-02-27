import { homedir } from "node:os";
import path from "node:path";
import { parseBoolean, parseInteger, parseList } from "./common.mjs";

export function loadConfig(env = process.env) {
  const mode = (env.ARMORCOWORK_MODE || "enforce").trim().toLowerCase();
  const envMode = (env.ARMORIQ_ENV || "production").trim().toLowerCase();
  const useProduction = parseBoolean(
    env.ARMORCOWORK_USE_PRODUCTION,
    envMode === "production"
  );
  const dataDir =
    env.ARMORCOWORK_DATA_DIR?.trim() || path.join(homedir(), ".claude", "armorcowork");
  const policyFile = env.ARMORCOWORK_POLICY_FILE?.trim() || path.join(dataDir, "policy.json");
  const runtimeFile = env.ARMORCOWORK_RUNTIME_FILE?.trim() || path.join(dataDir, "runtime.json");
  const timeoutMs = parseInteger(env.ARMORCOWORK_TIMEOUT_MS, 8000);
  const backendEndpoint =
    env.ARMORCOWORK_BACKEND_ENDPOINT?.trim() ||
    env.BACKEND_ENDPOINT?.trim() ||
    (useProduction ? "https://customer-api.armoriq.ai" : "http://127.0.0.1:3000");
  const iapEndpoint =
    env.ARMORCOWORK_IAP_ENDPOINT?.trim() ||
    env.IAP_ENDPOINT?.trim() ||
    (useProduction ? "https://customer-iap.armoriq.ai" : "http://127.0.0.1:8000");
  const proxyEndpoint =
    env.ARMORCOWORK_PROXY_ENDPOINT?.trim() ||
    env.PROXY_ENDPOINT?.trim() ||
    (useProduction ? "https://customer-proxy.armoriq.ai" : "http://127.0.0.1:3001");

  return {
    mode: mode === "monitor" ? "monitor" : "enforce",
    dataDir,
    policyFile,
    runtimeFile,
    useProduction,
    backendEndpoint,
    iapEndpoint,
    proxyEndpoint,
    apiKey: env.ARMORIQ_API_KEY?.trim() || "",
    useSdkIntent: parseBoolean(env.ARMORCOWORK_USE_SDK_INTENT, true),
    intentEndpoint: env.ARMORCOWORK_INTENT_URL?.trim() || "",
    verifyStepEndpoint:
      env.ARMORCOWORK_VERIFY_STEP_URL?.trim() || `${backendEndpoint}/iap/verify-step`,
    validitySeconds: parseInteger(env.ARMORCOWORK_VALIDITY_SECONDS, 60),
    timeoutMs,
    maxRetries: parseInteger(env.ARMORCOWORK_MAX_RETRIES, 3),
    verifySsl: parseBoolean(env.ARMORCOWORK_VERIFY_SSL, true),
    llmId: env.ARMORCOWORK_LLM_ID?.trim() || "claude-code",
    mcpName: env.ARMORCOWORK_MCP_NAME?.trim() || "claude-code",
    userId: env.ARMORCOWORK_USER_ID?.trim() || "claude-user",
    agentId: env.ARMORCOWORK_AGENT_ID?.trim() || "claude-code",
    contextId: env.ARMORCOWORK_CONTEXT_ID?.trim() || "default",
    intentRequired: parseBoolean(env.ARMORCOWORK_INTENT_REQUIRED, false),
    requireCsrgProofs: parseBoolean(env.REQUIRE_CSRG_PROOFS, true),
    csrgVerifyEnabled: parseBoolean(env.CSRG_VERIFY_ENABLED, true),
    policyUpdateEnabled: parseBoolean(env.ARMORCOWORK_POLICY_UPDATE_ENABLED, true),
    policyUpdateAllowList: parseList(env.ARMORCOWORK_POLICY_UPDATE_ALLOWLIST || "*"),
    contextHintsEnabled: parseBoolean(env.ARMORCOWORK_CONTEXT_HINTS_ENABLED, true),
    debug: parseBoolean(env.ARMORCOWORK_DEBUG, false),
    sanitize: {
      maxChars: parseInteger(env.ARMORCOWORK_MAX_PARAM_CHARS, 2000),
      maxDepth: parseInteger(env.ARMORCOWORK_MAX_PARAM_DEPTH, 4),
      maxKeys: parseInteger(env.ARMORCOWORK_MAX_PARAM_KEYS, 50),
      maxItems: parseInteger(env.ARMORCOWORK_MAX_PARAM_ITEMS, 50)
    }
  };
}
