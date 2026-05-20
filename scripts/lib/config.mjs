import { homedir } from "node:os";
import { readFileSync } from "node:fs";
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

/**
 * armorClaude config — after Phase 10's UI shift.
 *
 *   userConfig (plugin UI)  → api_key only
 *   env vars                → ARMORIQ_ENV switch + paths + debug
 *   everything else         → hardcoded to the tested-good default
 *
 * The plugin used to expose ~38 env vars and 5 userConfig fields. Most of
 * those were defaults nobody changed. Tests pinned down the right value
 * for every behavior toggle, so the toggles themselves don't need to ship.
 *
 * Branch contract:
 *   - dev branch:  ARMORIQ_ENV=development → 127.0.0.1 stack
 *                  anything else (default) → cloud (staging URLs pre-cutover)
 *   - main branch: drops ARMORIQ_ENV entirely; backend + csrg hardcoded
 *                  to api.armoriq.ai + iap.armoriq.ai
 *
 * Operators who really need a different value can edit this file —
 * scripts/lib/config.mjs IS the config now.
 */
export function loadConfig(env = process.env) {
  // ── ENV switch (deployment-time; dev branch only) ──
  const useProduction =
    (env.ARMORIQ_ENV || "production").trim().toLowerCase() === "production";

  // ── Paths ──
  const dataDir =
    env.CLAUDE_PLUGIN_DATA?.trim() ||
    env.ARMORCLAUDE_DATA_DIR?.trim() ||
    path.join(homedir(), ".claude", "armorclaude");
  const policyFile =
    env.ARMORCLAUDE_POLICY_FILE?.trim() || path.join(dataDir, "policy.json");
  const runtimeFile =
    env.ARMORCLAUDE_RUNTIME_FILE?.trim() || path.join(dataDir, "runtime.json");

  // ── Endpoints (derived purely from useProduction) ──
  // Both URLs map to Cloud Run *-staging services in conmap-auto's
  // us-central1 region while we're pre-cutover. The main-branch PR
  // swaps these for api.armoriq.ai + iap.armoriq.ai.
  const backendEndpoint = useProduction
    ? "https://staging-api.armoriq.ai"
    : "http://127.0.0.1:3000";
  const csrgEndpoint = useProduction
    ? "https://iap-staging.armoriq.ai"
    : "http://127.0.0.1:8080";

  // ── The one userConfig field: api_key. UI primary, legacy env fallback. ──
  let apiKey = pluginOpt(env, "API_KEY", "ARMORIQ_API_KEY");
  if (!apiKey) {
    try {
      const creds = JSON.parse(
        readFileSync(path.join(homedir(), ".armoriq", "credentials.json"), "utf-8")
      );
      if (typeof creds?.apiKey === "string") apiKey = creds.apiKey;
    } catch {
      // no credentials file — local-only mode
    }
  }

  return {
    // Paths / endpoints
    dataDir,
    policyFile,
    runtimeFile,
    useProduction,
    backendEndpoint,
    csrgEndpoint,
    verifyStepEndpoint: `${backendEndpoint}/iap/verify-step`,

    // userConfig-driven (the only one)
    apiKey,
    auditEnabled: Boolean(apiKey),

    // Hardcoded — every behaviour toggle uses the value we've tested into
    // the right default. To change one, edit this file.
    mode: "enforce",
    intentRequired: true,
    auditWal: true,
    autoReanchor: true,
    autoRevokeOnEnd: true,
    daemonEnabled: true,
    csrgVerifyEnabled: true,
    requireCsrgProofs: true,
    cryptoPolicyEnabled: false,
    strictParamCheck: false,           // advisory — LLM params are predictions
    policyUpdateEnabled: true,
    policyUpdateAllowList: ["*"],

    // Identity — backend derives real identity from API key.
    llmId: "claude-code",
    mcpName: "claude-code",
    userId: "claude-user",
    agentId: "claude-code",
    contextId: "default",

    // Tuning — sane defaults nobody tunes.
    validitySeconds: 600,
    refreshThresholdSeconds: 30,
    timeoutMs: 8000,
    maxRetries: 1,
    verifySsl: true,
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },

    // Always-on legacy flags (kept for downstream call-site compatibility).
    useSdkIntent: true,
    planningEnabled: true,
    contextHintsEnabled: true,

    debug: parseBoolean(env.ARMORCLAUDE_DEBUG, false)
  };
}
