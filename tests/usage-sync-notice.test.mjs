import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleSessionStart } from "../scripts/lib/engine.mjs";

// A dead loopback endpoint: SessionStart fires registry and policy sync, and
// this keeps the test off the network without stubbing the hook itself.
const BACKEND = "http://127.0.0.1:9";
const NOTICE = "usage reporting is OFF";

async function startWith(overrides) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "usage-sync-notice-"));
  const config = {
    mode: "enforce",
    intentRequired: false,
    unconfigured: false,
    hadUnusableKey: false,
    usageSyncEnabled: true,
    dataDir: tmp,
    policyFile: path.join(tmp, "policy.json"),
    runtimeFile: path.join(tmp, "runtime.json"),
    apiKey: "ak_live_abc1234567890",
    backendEndpoint: BACKEND,
    debug: false,
    ...overrides,
  };
  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: `s-${Math.random()}` },
    config
  );
  return output?.hookSpecificOutput?.additionalContext || "";
}

test("SessionStart warns when connected but usage sync is off", async () => {
  const ctx = await startWith({ usageSyncEnabled: false });
  assert.ok(ctx.includes(NOTICE), "a connected session with sync off must say so");
  assert.ok(ctx.includes("disable_usage_sync"), "it must name the option to unset");
});

test("SessionStart stays quiet when usage sync is on", async () => {
  const ctx = await startWith({ usageSyncEnabled: true });
  assert.ok(!ctx.includes(NOTICE), "a reporting session must not be warned");
});

test("SessionStart does not add the sync notice when not connected", async () => {
  const ctx = await startWith({ unconfigured: true, apiKey: "", usageSyncEnabled: false });
  assert.ok(ctx.includes("NOT connected"), "the connect banner still owns this case");
  assert.ok(!ctx.includes(NOTICE), "signing in is the fix, so do not stack a second warning");
});
