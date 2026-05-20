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

/**
 * The single env-knob philosophy:
 *
 * The plugin used to expose ~38 env vars. Most were either (a) hardcoded
 * defaults nobody changed, (b) parallel ways to express the same thing, or
 * (c) dead flags left over from removed features. This file is the result
 * of paring that down to the 14 knobs that actually matter at runtime, plus
 * a handful of paths the plugin runtime injects.
 *
 * Branch contract:
 *   - `main`  ships to production, uses `useProduction=true` by default,
 *             talks to staging-api.armoriq.ai (until prod cutover).
 *   - `dev`   keeps `ARMORIQ_ENV=development` (or USE_PRODUCTION=false) so
 *             local stacks point at 127.0.0.1.
 *
 * Everything else has a sane hardcoded default.
 */
export function loadConfig(env = process.env) {
  // ── env switch (dev branch only; main hardcodes prod via the default) ──
  const envMode = (env.ARMORIQ_ENV || "production").trim().toLowerCase();
  const useProduction = parseBoolean(
    pluginOpt(env, "USE_PRODUCTION", "ARMORCLAUDE_USE_PRODUCTION") || undefined,
    envMode === "production"
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

  // ── endpoints ──
  const backendEndpoint =
    env.ARMORCLAUDE_BACKEND_ENDPOINT?.trim() ||
    (useProduction
      ? "https://staging-api.armoriq.ai"
      : "http://127.0.0.1:3000");
  const csrgEndpoint =
    pluginOpt(env, "CSRG_ENDPOINT", "CSRG_URL") ||
    (useProduction
      ? "https://iap.armoriq.ai"
      : "http://127.0.0.1:8080");

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
    // Behaviour mode — hardcoded enforce. Was ARMORCLAUDE_MODE; the only
    // other value was "monitor" which nobody ran in practice.
    mode: "enforce",

    // Paths / endpoints
    dataDir,
    policyFile,
    runtimeFile,
    useProduction,
    backendEndpoint,
    csrgEndpoint,
    apiKey,

    // Identity — hardcoded. Was 5 env vars (LLM_ID, MCP_NAME, USER_ID,
    // AGENT_ID, CONTEXT_ID); all defaulted to "claude-code" / "claude-user"
    // / "default" and nobody overrode them. The backend derives real
    // identity from the API key + Claude Code session.
    llmId: "claude-code",
    mcpName: "claude-code",
    userId: "claude-user",
    agentId: "claude-code",
    contextId: "default",

    // Derived endpoint — was ARMORCLAUDE_VERIFY_STEP_URL with the same fallback.
    verifyStepEndpoint: `${backendEndpoint}/iap/verify-step`,

    // Token lifetime tuning — kept (operators tune these).
    validitySeconds: parseInteger(env.ARMORCLAUDE_VALIDITY_SECONDS, 600),
    refreshThresholdSeconds: parseInteger(env.ARMORCLAUDE_REFRESH_THRESHOLD_SECONDS, 30),

    // HTTP tuning — hardcoded. Was ARMORCLAUDE_TIMEOUT_MS / _MAX_RETRIES /
    // _VERIFY_SSL. 8 s is fine; one retry is the only sane value (more
    // stalls Claude on hung backends); SSL must be true in prod and the
    // override was a footgun.
    timeoutMs: 8000,
    maxRetries: 1,
    verifySsl: true,

    // Core enforcement toggle — kept.
    intentRequired: parseBoolean(
      pluginOpt(env, "INTENT_REQUIRED", "ARMORCLAUDE_INTENT_REQUIRED") || undefined,
      true
    ),

    // CSRG verification — compulsory. Was CSRG_VERIFY_ENABLED + REQUIRE_CSRG_PROOFS,
    // two flags for the same path; they're the security primitive, not a toggle.
    requireCsrgProofs: true,
    csrgVerifyEnabled: true,

    // Policy management — kept (operators may want to gate which MCP tools
    // can call policy_update; empty/missing allowlist disables it).
    policyUpdateEnabled: parseBoolean(env.ARMORCLAUDE_POLICY_UPDATE_ENABLED, true),
    policyUpdateAllowList: parseList(
      env.ARMORCLAUDE_POLICY_UPDATE_ALLOWLIST || "*"
    ),

    // Audit — derived from apiKey presence. Was ARMORCLAUDE_AUDIT_ENABLED
    // with the same derivation; no real reason to expose it.
    auditEnabled: Boolean(apiKey),
    auditWal: parseBoolean(env.ARMORCLAUDE_AUDIT_WAL, true),

    // Trust update lifecycle. autoReanchor + daemonEnabled hardcoded true
    // post-Phase-4 (intermediate-key signing made the cost negligible and
    // the daemon soak finished). autoRevokeOnEnd + strictParamCheck are
    // real toggles operators may flip.
    autoReanchor: true,
    autoRevokeOnEnd: parseBoolean(env.ARMORCLAUDE_AUTO_REVOKE_ON_END, true),
    strictParamCheck: parseBoolean(env.ARMORCLAUDE_STRICT_PARAM_CHECK, false),

    // Phase 4 Tier B daemon — always on.
    daemonEnabled: true,

    // Always-on behaviours. Were:
    //   ARMORCLAUDE_USE_SDK_INTENT  — only the SDK path is exercised now
    //   ARMORCLAUDE_PLANNING_ENABLED  — disabling planning when intent is
    //     required leaves Claude blind to what to declare; effectively useless
    //   ARMORCLAUDE_CONTEXT_HINTS_ENABLED  — policy-update hints in deny
    //     output, gated already by policyUpdateEnabled
    //   ARMORCLAUDE_CRYPTO_POLICY_ENABLED  — Merkle proof inclusion; the
    //     csrgVerify path already governs this end-to-end
    useSdkIntent: true,
    planningEnabled: true,
    contextHintsEnabled: true,
    cryptoPolicyEnabled: false,

    // Intent endpoint override path — kept-but-deprecated. The SDK path
    // covers every consumer today; this is the HTTP-direct escape hatch
    // for tenants that don't have the SDK shape.
    intentEndpoint: "",

    // Param sanitization — hardcoded sane defaults. Was 4 env vars
    // (MAX_PARAM_CHARS / _DEPTH / _KEYS / _ITEMS) that nobody touched.
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },

    debug: parseBoolean(env.ARMORCLAUDE_DEBUG, false)
  };
}
