import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { declaredCli, loginCommand } from "../scripts/lib/config.mjs";
import { handleSessionStart } from "../scripts/lib/engine.mjs";
import { loadConfigWithLogins } from "./helpers/login-profile.mjs";

const PROD = "https://api.armoriq.ai";
const LOGIN_LINE = `No ArmorClaude login for ${PROD}. Run: armoriq-dev login --product armorclaude`;

// ---------------------------------------------------------------------------
// Enforcement is gated on being "connected" (a usable, SDK-format API key).
// Fresh `claude plugin install` runs with no key → the plugin must NOT brick
// the session; it runs in monitor mode until the user connects.
// ---------------------------------------------------------------------------

test("loadConfig: a usable ak_ key connects → enforce + intent required", () => {
  const config = loadConfigWithLogins([{ backend: PROD, apiKey: "ak_live_abc1234567890" }], {
    ARMORIQ_ENV: "production",
  });
  assert.equal(config.apiKey, "ak_live_abc1234567890");
  assert.equal(config.mode, "enforce");
  assert.equal(config.intentRequired, true);
  assert.equal(config.unconfigured, false);
});

test("loadConfig: a bad-format key is dropped → monitor, never handed to the SDK", () => {
  const config = loadConfigWithLogins([{ backend: PROD, apiKey: "old-style-key-not-ak-format" }], {
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
    backendEndpoint: PROD,
    debug: false,
  };
  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "unconfig-1" },
    config
  );
  const ctx = output?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("NOT connected"), "banner should say the plugin is not connected");
  assert.ok(ctx.includes("MONITOR"), "banner should state monitor mode");
  assert.ok(ctx.includes(LOGIN_LINE), "banner should tell the model how to sign in");
  assert.equal(output?.systemMessage, LOGIN_LINE);
  // Must not be a deny/block decision — SessionStart only adds context.
  assert.notEqual(output?.hookSpecificOutput?.permissionDecision, "deny");
});

test("SessionStart when unconfigured: the login line shows once per session, the monitor context every time", async () => {
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
    backendEndpoint: PROD,
    debug: false,
  };
  const start = (session_id) =>
    handleSessionStart({ hook_event_name: "SessionStart", session_id }, config);
  const first = await start("once-1");
  const resumed = await start("once-1");
  const other = await start("once-2");
  assert.deepEqual(
    [first, resumed, other].map((o) => o?.systemMessage),
    [LOGIN_LINE, undefined, LOGIN_LINE]
  );
  for (const o of [first, resumed, other]) {
    const ctx = o?.hookSpecificOutput?.additionalContext || "";
    assert.ok(ctx.includes("MONITOR") && ctx.includes(LOGIN_LINE), ctx);
  }
});

test("the login command names the CLI the installed SDK package declares", () => {
  const { bin } = createRequire(import.meta.url)("@armoriq/sdk-dev/package.json");
  assert.deepEqual(Object.keys(bin), ["armoriq-dev"]);
  assert.equal(loginCommand(), "armoriq-dev login --product armorclaude");
});

test("the SDK package must declare exactly one CLI by name, or the login command fails", () => {
  assert.equal(
    declaredCli({ name: "@armoriq/sdk-dev", bin: { "armoriq-dev": "x.js" } }),
    "armoriq-dev"
  );
  for (const bin of ["dist/cli/index.js", {}, { a: "a.js", b: "b.js" }, undefined]) {
    assert.throws(() => declaredCli({ name: "@armoriq/sdk-dev", bin }), /@armoriq\/sdk-dev/);
  }
});
