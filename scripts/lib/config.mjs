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
 * armorClaude config — main branch (production).
 *
 *   userConfig (plugin UI)  → api_key only
 *   env vars                → paths + debug
 *   everything else         → hardcoded to the tested-good default
 *
 * Production-hardcoded. No staging/local switch — `main` ships against
 * api.armoriq.ai + iap.armoriq.ai unconditionally. The dev branch keeps
 * the ARMORIQ_ENV toggle for local development; main is the
 * end-user-facing artifact and must be unambiguously production.
 *
 * Operators who really need a different value can edit this file —
 * scripts/lib/config.mjs IS the config now.
 */
export function loadConfig(env = process.env) {
  // ── Paths ──
  const dataDir =
    env.CLAUDE_PLUGIN_DATA?.trim() ||
    env.ARMORCLAUDE_DATA_DIR?.trim() ||
    path.join(homedir(), ".claude", "armorclaude");
  const policyFile = env.ARMORCLAUDE_POLICY_FILE?.trim() || path.join(dataDir, "policy.json");
  const runtimeFile = env.ARMORCLAUDE_RUNTIME_FILE?.trim() || path.join(dataDir, "runtime.json");

  // ── Endpoints — production, hardcoded. ──
  // No staging/local toggle on this branch. The dev branch keeps
  // ARMORIQ_ENV for those flows.
  const backendEndpoint = "https://api.armoriq.ai";
  const csrgEndpoint = "https://iap.armoriq.ai";
  const useProduction = true;

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
    strictParamCheck: false, // advisory — LLM params are predictions
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

    debug: parseBoolean(env.ARMORCLAUDE_DEBUG, false),
  };
}
