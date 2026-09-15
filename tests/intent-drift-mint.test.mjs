import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePreToolUse } from "../scripts/lib/engine.mjs";
import { writeJson } from "../scripts/lib/fs-store.mjs";

// Regression cover for a drift bypass that only appeared once an API key was
// configured — i.e. exactly the paying-customer path.
//
// handlePreToolUse used to mint an intent token before checking the registered
// plan, and the mint payload carried toolName/toolInput but not the plan. The
// backend therefore built a plan around the very call being checked, the
// registered plan was overwritten in runtime.json, and the call was validated
// against a plan derived from itself. A session whose plan declared only Read
// would run Bash without complaint.
//
// These tests need no backend: the guard must reject before any mint is
// attempted, so a bare api key with no reachable server is sufficient. If the
// guard regresses, the SDK call is attempted and the assertions fail.

function buildConfig(tmpDir, overrides = {}) {
  return {
    mode: "enforce",
    dataDir: tmpDir,
    policyFile: path.join(tmpDir, "policy.json"),
    runtimeFile: path.join(tmpDir, "runtime.json"),
    useProduction: false,
    backendEndpoint: "http://127.0.0.1:1",
    csrgEndpoint: "http://127.0.0.1:1",
    apiKey: "test-key",
    useSdkIntent: false,
    intentEndpoint: "",
    verifyStepEndpoint: "",
    validitySeconds: 60,
    timeoutMs: 2000,
    maxRetries: 0,
    verifySsl: true,
    llmId: "claude-code",
    mcpName: "claude-code",
    userId: "test-user",
    agentId: "test-agent",
    contextId: "default",
    intentRequired: true,
    requireCsrgProofs: true,
    csrgVerifyEnabled: true,
    cryptoPolicyEnabled: false,
    auditEnabled: false,
    planningEnabled: false,
    debug: false,
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
    ...overrides,
  };
}

// An all-allow policy switches the plugin to frictionless mode and disables
// intent entirely, so the fixture needs at least one forbid statement for
// intent enforcement to be active at all.
async function writeEnforcingPolicy(config) {
  await writeJson(config.policyFile, {
    version: 1,
    updatedAt: new Date().toISOString(),
    policy: {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "enforcing", description: "" },
      defaults: { decision: "allow", conflictResolution: "deny_overrides" },
      statements: [
        {
          id: "forbid-webfetch",
          effect: "forbid",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", in: ["WebFetch"] },
          resource: { type: "workspace", scope: "current" },
          conditions: [],
        },
      ],
    },
    history: [],
  });
}

test("off-plan tool is denied instead of minting a plan around itself", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-drift-"));
  const config = buildConfig(tmp);
  await writeEnforcingPolicy(config);
  await writeJson(config.runtimeFile, {
    sessions: {
      s1: {
        plan: { steps: [{ action: "Read" }], metadata: { goal: "read the readme" } },
        allowedActions: ["read"],
        updatedAt: Math.floor(Date.now() / 1000),
      },
    },
  });

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    config
  );

  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(
    output?.hookSpecificOutput?.permissionDecisionReason || "",
    /intent drift|not in plan/i
  );
});

test("registered plan survives an off-plan call", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-drift-"));
  const config = buildConfig(tmp);
  await writeEnforcingPolicy(config);
  await writeJson(config.runtimeFile, {
    sessions: {
      s1: {
        plan: { steps: [{ action: "Read" }], metadata: { goal: "read the readme" } },
        allowedActions: ["read"],
        updatedAt: Math.floor(Date.now() / 1000),
      },
    },
  });

  await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    config
  );

  const { readJson } = await import("../scripts/lib/fs-store.mjs");
  const runtime = await readJson(config.runtimeFile);
  const steps = runtime?.sessions?.s1?.plan?.steps || [];
  assert.deepEqual(
    steps.map((s) => s.action),
    ["Read"],
    "the registered plan must not be replaced by the rejected tool call"
  );
});

test("a session with no registered plan is denied rather than issued one", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-drift-"));
  const config = buildConfig(tmp);
  await writeEnforcingPolicy(config);
  await writeJson(config.runtimeFile, { sessions: {} });

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "no-plan",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    config
  );

  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(
    output?.hookSpecificOutput?.permissionDecisionReason || "",
    /intent plan missing|register_intent_plan/i
  );
});

test("monitor mode still reports but does not block", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-drift-"));
  const config = buildConfig(tmp, { mode: "monitor" });
  await writeEnforcingPolicy(config);
  await writeJson(config.runtimeFile, {
    sessions: {
      s1: {
        plan: { steps: [{ action: "Read" }], metadata: { goal: "read the readme" } },
        allowedActions: ["read"],
        updatedAt: Math.floor(Date.now() / 1000),
      },
    },
  });

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    config
  );

  assert.notEqual(output?.hookSpecificOutput?.permissionDecision, "deny");
});
