// A saved login is used only when it was minted for armorclaude on the backend the plugin calls (#170).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { handleSessionStart } from "../scripts/lib/engine.mjs";

const STAGING = "https://staging-api.armoriq.ai";
const KEY = "ak_test_savedlogin0000000000000000";

function withSavedLogin(record, fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "armorclaude-creds-"));
  const file = path.join(home, ".armoriq", "credentials.json");
  assert.ok(file.startsWith(os.tmpdir()), file);
  mkdirSync(path.dirname(file));
  writeFileSync(file, JSON.stringify({ apiKey: KEY, orgId: "org-saved", ...record }));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(os.homedir(), home);
    return fn();
  } finally {
    process.env.HOME = saved;
  }
}

test("a login for armorclaude on the configured backend is used", () => {
  const config = withSavedLogin({ product: "armorclaude", backend: STAGING }, () => loadConfig({}));
  assert.equal(config.apiKey, KEY);
  assert.equal(config.orgId, "org-saved");
  assert.equal(config.unconfigured, false);
  assert.equal(config.ignoredSavedCredential, null);
});

test("a trailing slash on the saved backend still matches", () => {
  const config = withSavedLogin({ product: "armorclaude", backend: `${STAGING}/` }, () =>
    loadConfig({})
  );
  assert.equal(config.apiKey, KEY);
});

test("a login for another product is not used", () => {
  const config = withSavedLogin({ product: "armorcodex", backend: STAGING }, () => loadConfig({}));
  assert.equal(config.apiKey, "");
  assert.equal(config.orgId, "");
  assert.equal(config.unconfigured, true);
  assert.deepEqual(config.ignoredSavedCredential, { product: "armorcodex", backend: STAGING });
});

test("a login minted on another backend is not sent to this one", () => {
  const config = withSavedLogin({ product: "armorclaude", backend: "https://api.armoriq.ai" }, () =>
    loadConfig({})
  );
  assert.equal(config.backendEndpoint, STAGING);
  assert.equal(config.apiKey, "");
  assert.deepEqual(config.ignoredSavedCredential, {
    product: "armorclaude",
    backend: "https://api.armoriq.ai",
  });
});

test("a login that recorded no product or backend is not used", () => {
  const config = withSavedLogin({}, () => loadConfig({}));
  assert.equal(config.apiKey, "");
  assert.deepEqual(config.ignoredSavedCredential, { product: "", backend: "" });
});

test("a key from the plugin option is used, and a mismatched login lends it no org", () => {
  const config = withSavedLogin({ product: "armorcodex", backend: STAGING }, () =>
    loadConfig({ CLAUDE_PLUGIN_OPTION_API_KEY: "ak_live_pluginoption000000000000" })
  );
  assert.equal(config.apiKey, "ak_live_pluginoption000000000000");
  assert.equal(config.orgId, "");
});

test("the setup banner names the ignored login and the login command", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "armorclaude-creds-banner-"));
  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "creds-banner-1" },
    {
      mode: "monitor",
      intentRequired: false,
      unconfigured: true,
      hadUnusableKey: false,
      ignoredSavedCredential: { product: "armorcodex", backend: STAGING },
      backendEndpoint: STAGING,
      dataDir,
      policyFile: path.join(dataDir, "policy.json"),
      runtimeFile: path.join(dataDir, "runtime.json"),
      apiKey: "",
      debug: false,
    }
  );
  const ctx = output?.hookSpecificOutput?.additionalContext || "";
  assert.match(ctx, /is for armorcodex on https:\/\/staging-api\.armoriq\.ai, not armorclaude on/);
  assert.match(ctx, /armoriq login --product armorclaude/);
});
