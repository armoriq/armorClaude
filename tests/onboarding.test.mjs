import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleSessionStart } from "../scripts/lib/engine.mjs";
import { savePolicyState } from "../scripts/lib/policy.mjs";

function buildConfig(tmpDir) {
  return {
    mode: "enforce",
    dataDir: tmpDir,
    policyFile: path.join(tmpDir, "policy.json"),
    runtimeFile: path.join(tmpDir, "runtime.json"),
    useProduction: false,
    backendEndpoint: "http://127.0.0.1:3000",
    csrgEndpoint: "http://127.0.0.1:8080",
    apiKey: "",
    useSdkIntent: false,
    intentEndpoint: "",
    verifyStepEndpoint: "",
    validitySeconds: 60,
    timeoutMs: 8000,
    maxRetries: 1,
    verifySsl: true,
    llmId: "claude-code",
    mcpName: "claude-code",
    userId: "test-user",
    agentId: "test-agent",
    contextId: "default",
    intentRequired: false,
    requireCsrgProofs: true,
    csrgVerifyEnabled: true,
    cryptoPolicyEnabled: false,
    auditEnabled: false,
    planningEnabled: false,
    debug: false,
    sanitize: {
      maxChars: 2000,
      maxDepth: 4,
      maxKeys: 50,
      maxItems: 50,
    },
  };
}

test("first-run onboarding: shows welcome when no policy.json exists", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "onboarding-test-"));
  const config = buildConfig(tmp);
  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "onboard-1" },
    config
  );
  const ctx = output?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("ArmorClaude active"));
  assert.ok(ctx.includes("Welcome to ArmorClaude"));
  assert.ok(ctx.includes("/armor policy template"));
  assert.ok(ctx.includes("all-allow"));
  assert.ok(ctx.includes("balanced"));
  assert.ok(ctx.includes("lockdown"));
  assert.ok(ctx.includes("Type /armor"));
});

test("onboarding sets flag file so it only shows once", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "onboarding-test-"));
  const config = buildConfig(tmp);

  await handleSessionStart({ hook_event_name: "SessionStart", session_id: "onboard-2a" }, config);
  const flagExists = await stat(path.join(tmp, "onboarding-shown")).then(
    () => true,
    () => false
  );
  assert.ok(flagExists, "onboarding-shown flag should be created");

  const output2 = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "onboard-2b" },
    config
  );
  const ctx2 = output2?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx2.includes("ArmorClaude active"));
  assert.ok(!ctx2.includes("Welcome to ArmorClaude"), "onboarding should not repeat");
});

test("no onboarding when policy.json already exists", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "onboarding-test-"));
  const config = buildConfig(tmp);
  await savePolicyState(config.policyFile, {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
    policy: { rules: [{ id: "p1", action: "allow", tool: "*" }] },
    history: [],
  });

  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "onboard-3" },
    config
  );
  const ctx = output?.hookSpecificOutput?.additionalContext || "";
  assert.ok(ctx.includes("ArmorClaude active"));
  assert.ok(!ctx.includes("Welcome to ArmorClaude"), "no onboarding when policy exists");
});
