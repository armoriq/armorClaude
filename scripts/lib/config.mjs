import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseBoolean } from "./common.mjs";

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

function normalizeArmoriqEnv(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (["production", "prod"].includes(normalized)) return "production";
  if (["staging", "stage"].includes(normalized)) return "staging";
  if (["development", "dev", "local", "test"].includes(normalized)) return "local";
  return "";
}

/**
 * armorClaude config — main branch (production).
 *
 *   userConfig (plugin UI)  → api_key only
 *   env vars                → paths + debug
 *   everything else         → hardcoded to the tested-good default
 *
 * Dev-branch default: staging. Main must keep production-hardcoded behavior
 * before release, but the dev plugin must never send staging keys to the
 * production API by accident.
 *
 * ARMORIQ_ENV:
 *   production/default -> api.armoriq.ai + iap.armoriq.ai
 *   staging/stage -> staging-api.armoriq.ai + iap-staging.armoriq.ai
 *   development/local/test -> local URLs, overridable for local stacks only
 */
export function loadConfig(env = process.env) {
  // ── Paths ──
  const dataDir =
    env.CLAUDE_PLUGIN_DATA?.trim() ||
    env.ARMORCLAUDE_DATA_DIR?.trim() ||
    path.join(homedir(), ".claude", "armorclaude");
  const policyFile = env.ARMORCLAUDE_POLICY_FILE?.trim() || path.join(dataDir, "policy.json");
  const runtimeFile = env.ARMORCLAUDE_RUNTIME_FILE?.trim() || path.join(dataDir, "runtime.json");

  // ── Endpoints ──
  // Local mock mode: enabled by env var OR presence of ~/.armoriq/local-mode file.
  // File-based flag avoids shell env var gymnastics on Windows.
  // Delete ~/.armoriq/local-mode to restore production mode.
  const localModeFile = path.join(homedir(), ".armoriq", "local-mode");
  const requestedEnv = normalizeArmoriqEnv(env.ARMORIQ_ENV) || "production";
  const localMock =
    parseBoolean(env.ARMORIQ_LOCAL_MOCK, false) ||
    existsSync(localModeFile) ||
    requestedEnv === "local";
  const activeEnv = localMock ? "local" : requestedEnv;
  const backendEndpoint =
    activeEnv === "local"
      ? env.ARMORIQ_BACKEND_URL?.trim() || "http://localhost:8000"
      : activeEnv === "production"
        ? "https://api.armoriq.ai"
        : "https://staging-api.armoriq.ai";
  const csrgEndpoint =
    activeEnv === "local"
      ? env.ARMORIQ_CSRG_URL?.trim() || "http://localhost:8000"
      : activeEnv === "production"
        ? "https://iap.armoriq.ai"
        : "https://iap-staging.armoriq.ai";
  const useProduction = activeEnv === "production";

  // ── userConfig fields. UI primary, legacy env fallback. ──
  let apiKey = pluginOpt(env, "API_KEY", "ARMORIQ_API_KEY");
  // Optional default policy template applied (staged for confirm) on first run.
  const defaultTemplate = pluginOpt(env, "DEFAULT_TEMPLATE");
  let orgId = env.ARMORIQ_ORG_ID?.trim() || "";

  // Observability is ON by default. Users can opt out via the
  // `disable_observability` plugin option or the ARMORIQ_OBSERVABILITY_DISABLED
  // env var (accepts true/1/yes).
  const observabilityDisabled = parseBoolean(
    pluginOpt(env, "DISABLE_OBSERVABILITY", "ARMORIQ_OBSERVABILITY_DISABLED"),
    false
  );
  try {
    const creds = JSON.parse(
      readFileSync(path.join(homedir(), ".armoriq", "credentials.json"), "utf-8")
    );
    if (!apiKey && typeof creds?.apiKey === "string") apiKey = creds.apiKey;
    if (!orgId && typeof creds?.orgId === "string") orgId = creds.orgId;
  } catch {
    // no credentials file — local-only mode
  }

  // A key is only usable if it matches the @armoriq/sdk key format
  // (ak_test_/ak_live_/ak_claw_). Anything else — empty, or a stale/old-format
  // key left over from a prior install — is treated as "not connected":
  //   • handing a bad-format key to `new ArmorIQClient(...)` throws in the
  //     constructor, which crashed the policy MCP server ("-32000").
  //   • enforcing without a working key just hard-blocks every tool, bricking
  //     the session on a fresh `claude plugin install` (no onboarding ran).
  // So we drop an unusable key and fall into monitor mode (see `connected`).
  const keyLooksUsable = /^ak_(test|live|claw)_/.test(apiKey);
  const hadUnusableKey = Boolean(apiKey) && !keyLooksUsable;
  if (hadUnusableKey) apiKey = "";
  // Effective key handed to the SDK. In local mock use a placeholder the SDK's
  // key-format check accepts (the mock server ignores auth). Everything that
  // keys off "do we have a working credential" uses this.
  const effectiveApiKey = apiKey || (localMock ? "ak_test_localmock000000000000" : "");
  // "Connected" == we have a usable key (or we're in local mock). Only then do
  // we enforce. Unconfigured installs run passively until the user connects.
  const connected = localMock || keyLooksUsable;

  return {
    // Paths / endpoints
    dataDir,
    policyFile,
    runtimeFile,
    armoriqEnv: activeEnv,
    useProduction,
    backendEndpoint,
    csrgEndpoint,
    verifyStepEndpoint: `${backendEndpoint}/iap/verify-step`,

    // ── Observability: ON by default (opt out via `disable_observability`
    //    plugin option / ARMORIQ_OBSERVABILITY_DISABLED). Additive + no-op
    //    unless a key or local mock gives us somewhere to ship spans. ──
    observabilityEnabled: !observabilityDisabled && Boolean(effectiveApiKey),
    observabilityEndpoint: backendEndpoint,
    observabilityProduct: "armorclaude",

    // userConfig-driven credential (see effectiveApiKey above: a bad-format key
    // is dropped, and local mock substitutes an SDK-accepted placeholder).
    apiKey: effectiveApiKey,
    orgId,
    auditEnabled: Boolean(effectiveApiKey),
    defaultTemplate,

    // Enforcement is gated on being connected. With a usable key (or local
    // mock) we enforce + require intent, exactly as before. Without one, we run
    // in monitor mode so the plugin never bricks an un-onboarded session; the
    // SessionStart banner tells the user how to connect. Once a valid key is
    // present, this flips back to enforce automatically.
    mode: connected ? "enforce" : "monitor",
    intentRequired: connected,
    // True when the plugin is installed but not connected (no usable key).
    // Drives the SessionStart setup banner.
    unconfigured: !connected,
    hadUnusableKey,
    auditWal: true,
    autoReanchor: true,
    autoRevokeOnEnd: true,
    daemonEnabled: true,
    // csrgVerifyEnabled drives verify-step heartbeats → activeSessions counter.
    // Production: false — org native policy on api.armoriq.io denies all paths
    //   for gmail.com domain, so verify-step always returns "blocked". Keeping
    //   this false lets tools run while the org policy issue is resolved upstream.
    // Local mock: true — mock always returns allowed, so heartbeats work and
    //   activeSessions shows the real count on the dashboard.
    csrgVerifyEnabled: localMock,
    requireCsrgProofs: false,
    cryptoPolicyEnabled: Boolean(effectiveApiKey),
    strictParamCheck: false, // advisory — LLM params are predictions
    policyUpdateEnabled: true,
    policyUpdateAllowList: ["*"],
    mcpDenyByDefault: true,
    enforcementEngine: env.ARMORCLAUDE_ENFORCEMENT_ENGINE?.trim() || "local",
    opaPdpUrl: env.ARMORCLAUDE_OPA_PDP_URL?.trim() || "",
    opaCacheTtlMs: 10000,
    opaTimeoutMs: 3000,
    opaCircuitBreakerThreshold: 15,
    opaCircuitResetMs: 10000,

    // Identity — backend derives real identity from API key.
    // productSlug is sent explicitly on dashboard telemetry (token usage) so
    // per-product attribution works even if the API key has product=NULL.
    productSlug: "armorclaude",
    llmId: "claude-code",
    mcpName: "claude-code",
    userId: "claude-user",
    agentId: "claude-code",
    contextId: "default",

    // Tuning — sane defaults nobody tunes.
    validitySeconds: 3600,
    refreshThresholdSeconds: 30,
    timeoutMs: 8000,
    maxRetries: 1,
    verifySsl: true,
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },

    // Always-on legacy flags (kept for downstream call-site compatibility).
    useSdkIntent: true,
    planningEnabled: true,

    debug: parseBoolean(env.ARMORCLAUDE_DEBUG, false),
  };
}
