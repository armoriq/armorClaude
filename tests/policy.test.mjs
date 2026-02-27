import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handlePreToolUse, handleUserPromptSubmit } from "../scripts/lib/engine.mjs";
import { checkToolAgainstPlan } from "../scripts/lib/intent.mjs";
import { evaluatePolicy } from "../scripts/lib/policy.mjs";

function buildConfig(tmpDir, overrides = {}) {
  return {
    mode: "enforce",
    dataDir: tmpDir,
    policyFile: path.join(tmpDir, "policy.json"),
    runtimeFile: path.join(tmpDir, "runtime.json"),
    useProduction: false,
    backendEndpoint: "http://127.0.0.1:3000",
    iapEndpoint: "http://127.0.0.1:8000",
    proxyEndpoint: "http://127.0.0.1:3001",
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
    policyUpdateEnabled: true,
    policyUpdateAllowList: ["*"],
    contextHintsEnabled: true,
    debug: false,
    sanitize: {
      maxChars: 2000,
      maxDepth: 4,
      maxKeys: 50,
      maxItems: 50
    },
    ...overrides
  };
}

test("evaluatePolicy denies matching deny rule", () => {
  const decision = evaluatePolicy({
    policy: {
      rules: [{ id: "policy1", action: "deny", tool: "web_fetch" }]
    },
    toolName: "web_fetch",
    toolParams: { url: "https://example.com" }
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /policy deny/i);
});

test("checkToolAgainstPlan rejects tool drift", () => {
  const decision = checkToolAgainstPlan({
    plan: { steps: [{ action: "read_file" }] },
    toolName: "web_fetch",
    toolInput: {}
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not in plan/i);
});

test("handleUserPromptSubmit applies policy command and blocks prompt", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcowork-test-"));
  const config = buildConfig(tmp);
  const output = await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: "Policy new: block web_fetch for payment data"
    },
    config
  );

  assert.equal(output?.decision, "block");
  assert.match(output?.reason || "", /policy updated/i);
});

test("handlePreToolUse denies when policy blocks tool", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcowork-test-"));
  const config = buildConfig(tmp);
  await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-2",
      prompt: "Policy new: block write"
    },
    config
  );

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-2",
      tool_name: "write",
      tool_input: { file_path: "a.txt" }
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
});

test("handlePreToolUse denies missing intent when strict", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcowork-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-3",
      tool_name: "read",
      tool_input: { file_path: "a.txt" }
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason || "", /intent plan missing/i);
});

test("handleUserPromptSubmit adds context hints for normal prompts", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcowork-test-"));
  const config = buildConfig(tmp, { contextHintsEnabled: true, policyUpdateEnabled: true });
  const output = await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-4",
      prompt: "summarize this file"
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.hookEventName, "UserPromptSubmit");
  assert.match(output?.hookSpecificOutput?.additionalContext || "", /policy_update/i);
});
