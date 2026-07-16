import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { handleSessionStart } from "../scripts/lib/engine.mjs";

// ---------------------------------------------------------------------------
// Enforcement is gated on being "connected" (a usable, SDK-format API key).
// Fresh `claude plugin install` runs with no key → the plugin must NOT brick
// the session; it runs in monitor mode until the user connects.
// ---------------------------------------------------------------------------

test("loadConfig: a usable ak_ key connects → enforce + intent required", () => {
  const config = loadConfig({
    CLAUDE_PLUGIN_OPTION_API_KEY: "ak_live_abc1234567890",
    ARMORIQ_ENV: "production",
  });
  assert.equal(config.apiKey, "ak_live_abc1234567890");
  assert.equal(config.mode, "enforce");
  assert.equal(config.intentRequired, true);
  assert.equal(config.unconfigured, false);
});

test("loadConfig: a bad-format key is dropped → monitor, never handed to the SDK", () => {
  // A bad plugin key preempts the ~/.armoriq/credentials.json fallback, so this
  // is deterministic regardless of what's on the test machine.
  const config = loadConfig({
    CLAUDE_PLUGIN_OPTION_API_KEY: "old-style-key-not-ak-format",
    ARMORIQ_ENV: "production",
  });
  assert.equal(config.apiKey, "", "bad-format key must be dropped, not sent to the SDK");
  assert.equal(config.mode, "monitor");
  assert.equal(config.intentRequired, false);
  assert.equal(config.unconfigured, true);
  assert.equal(config.hadUnusableKey, true);
});

test("SessionStart when unconfigured: shows connect banner, runs passively (no block)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "connect-gating-"));
  const config = {
    mode: "monitor",
    intentRequired: false,
    unconfigured: true,
    hadUnusableKey: false,
    dataDir: tmp,
    policyFile: path.join(tmp, "policy.json"),
    runtimeFile: path.join(tmp, "runtime.json"),
    apiKey: "",
    debug: false,
  };
  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "unconfig-1" },
    config
  );
  const ctx = output?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("NOT connected"), "banner should say the plugin is not connected");
  assert.ok(ctx.includes("MONITOR"), "banner should state monitor mode");
  assert.ok(ctx.includes("tools.armoriq.ai"), "banner should point to the dashboard");
  // Must not be a deny/block decision — SessionStart only adds context.
  assert.notEqual(output?.hookSpecificOutput?.permissionDecision, "deny");
});
