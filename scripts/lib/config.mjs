import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseBoolean, parseList } from "./common.mjs";

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
 * The single env-knob philosophy:
 *
 * Was ~38 env vars. After two prune passes this is down to 8 user-settable
 * knobs plus a handful of paths Claude Code injects. Everything else is a
 * hardcoded default; an operator who needs a different value can edit this
 * file (it IS the config).
 *
 * Branch contract:
 *   - `main`  ships to production; useProduction=true default →
 *             staging-api.armoriq.ai (until prod cutover).
 *   - `dev`   local stacks via `ARMORCLAUDE_USE_PRODUCTION=false` →
 *             127.0.0.1:3000 + 127.0.0.1:8080.
 */
export function loadConfig(env = process.env) {
  // ── prod vs local switch ──
  const useProduction = parseBoolean(
    pluginOpt(env, "USE_PRODUCTION", "ARMORCLAUDE_USE_PRODUCTION") || undefined,
    true
  );

  // ── data + state paths ──
  const dataDir =
    env.CLAUDE_PLUGIN_DATA?.trim() ||
    env.ARMORCLAUDE_DATA_DIR?.trim() ||
    path.join(homedir(), ".claude", "armorclaude");
  const policyFile =
    env.ARMORCLAUDE_POLICY_FILE?.trim() || path.join(dataDir, "policy.json");
  const runtimeFile =
    env.ARMORCLAUDE_RUNTIME_FILE?.trim() || path.join(dataDir, "runtime.json");

  // ── endpoints — derived purely from useProduction ──
  // Both URLs map to Cloud Run *-staging services in conmap-auto's
  // us-central1 region while we're pre-cutover. When the cutover happens
  // the staging-api / iap-staging hosts get swapped for api / iap and
  // this block is the one line that changes.
  const backendEndpoint = useProduction
    ? "https://staging-api.armoriq.ai"
    : "http://127.0.0.1:3000";
  const csrgEndpoint = useProduction
    ? "https://iap-staging.armoriq.ai"
    : "http://127.0.0.1:8080";

  // ── auth ──
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
    // Behaviour mode — hardcoded enforce.
    mode: "enforce",

    // Paths / endpoints
    dataDir,
    policyFile,
    runtimeFile,
    useProduction,
    backendEndpoint,
    csrgEndpoint,
    apiKey,

    // Identity — hardcoded. Backend derives real identity from API key +
    // Claude Code session.
    llmId: "claude-code",
    mcpName: "claude-code",
    userId: "claude-user",
    agentId: "claude-code",
    contextId: "default",

    // Derived endpoint.
    verifyStepEndpoint: `${backendEndpoint}/iap/verify-step`,

    // Token lifetime — hardcoded. 10 minutes is long enough for multi-step
    // agentic work without forcing a replan mid-turn. 30s refresh window
    // ahead of expiry prevents tool calls from racing the boundary.
    validitySeconds: 600,
    refreshThresholdSeconds: 30,

    // HTTP tuning — hardcoded.
    timeoutMs: 8000,
    maxRetries: 1,
    verifySsl: true,

    // Core enforcement — always on. If you've installed armorClaude you
    // want intent enforcement; toggling it off defeats the plugin.
    intentRequired: true,

    // CSRG verification — compulsory (it's the security primitive, not a toggle).
    requireCsrgProofs: true,
    csrgVerifyEnabled: true,

    // Policy management — kept (operators may gate which keys MCP
    // policy_update can write).
    policyUpdateEnabled: parseBoolean(env.ARMORCLAUDE_POLICY_UPDATE_ENABLED, true),
    policyUpdateAllowList: parseList(
      env.ARMORCLAUDE_POLICY_UPDATE_ALLOWLIST || "*"
    ),

    // Audit — derived from apiKey presence. WAL durability is always on
    // (in-memory path was the pre-WAL fallback; no reason to ever choose it).
    auditEnabled: Boolean(apiKey),
    auditWal: true,

    // Trust update lifecycle — all hardcoded after two cleanup passes.
    autoReanchor: true,
    autoRevokeOnEnd: true,
    strictParamCheck: false,

    // Phase 4 Tier B daemon — always on.
    daemonEnabled: true,

    // Always-on legacy flags (kept in the config object for compatibility
    // with existing call sites that read them; the env vars are gone).
    useSdkIntent: true,
    planningEnabled: true,
    contextHintsEnabled: true,
    cryptoPolicyEnabled: false,
    intentEndpoint: "",

    // Param sanitization — hardcoded sane defaults.
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },

    debug: parseBoolean(env.ARMORCLAUDE_DEBUG, false)
  };
}
