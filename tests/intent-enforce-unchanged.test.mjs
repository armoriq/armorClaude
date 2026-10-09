import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { handlePreToolUse } from "../scripts/lib/engine.mjs";
import { computePolicyHash, loadPolicyState, savePolicyState } from "../scripts/lib/policy.mjs";

const PLAN = {
  steps: [{ action: "Bash", mcp: "claude-code", metadata: { inputs: { command: "ls" } } }],
};
const BASH = {
  hook_event_name: "PreToolUse",
  session_id: "s1",
  tool_name: "Bash",
  tool_input: { command: "ls" },
};

function buildConfig(tmpDir, overrides) {
  return {
    mode: "enforce",
    dataDir: tmpDir,
    policyFile: path.join(tmpDir, "policy.json"),
    runtimeFile: path.join(tmpDir, "runtime.json"),
    backendEndpoint: "http://127.0.0.1:9",
    csrgEndpoint: "http://127.0.0.1:9",
    apiKey: "ak_test_12345678",
    verifyStepEndpoint: "",
    validitySeconds: 60,
    timeoutMs: 2000,
    maxRetries: 0,
    llmId: "claude-code",
    mcpName: "claude-code",
    userId: "test-user",
    agentId: "test-agent",
    intentRequired: true,
    requireCsrgProofs: false,
    csrgVerifyEnabled: false,
    cryptoPolicyEnabled: false,
    auditEnabled: false,
    planningEnabled: false,
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
    ...overrides,
  };
}

async function confirmedPolicySession(overrides, session) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-enforce-"));
  const config = buildConfig(tmp, overrides);
  await savePolicyState(config.policyFile, {
    version: 1,
    policy: {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "confirmed", description: "" },
      defaults: { decision: "allow", conflictResolution: "deny_overrides" },
      statements: [
        {
          id: "hold-webfetch",
          effect: "require_approval",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", eq: "WebFetch" },
          resource: { type: "workspace", scope: "current" },
          conditions: [],
        },
      ],
    },
  });
  const policyHash = computePolicyHash((await loadPolicyState(config.policyFile)).policy);
  await writeFile(
    config.runtimeFile,
    JSON.stringify({
      sessions: {
        s1: {
          plan: PLAN,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          policyHash,
          intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
          ...session,
        },
      },
    })
  );
  return config;
}

function assertDenied(output, reason) {
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny", JSON.stringify(output));
  assert.match(output.hookSpecificOutput.permissionDecisionReason, reason);
}

test("with a confirmed policy, a missing CSRG proof still denies the tool", async () => {
  const config = await confirmedPolicySession(
    {
      requireCsrgProofs: true,
      csrgVerifyEnabled: true,
      verifyStepEndpoint: "http://127.0.0.1:9/iap/verify-step",
    },
    { intentTokenRaw: JSON.stringify({ jwtToken: "jwt", plan: PLAN }) }
  );
  assertDenied(await handlePreToolUse(BASH, config), /CSRG/);
});

test("with a confirmed policy, a malformed CSRG proof header still denies the tool", async () => {
  const config = await confirmedPolicySession(
    {},
    { intentTokenRaw: JSON.stringify({ jwtToken: "jwt", plan: PLAN }) }
  );
  const output = await handlePreToolUse(
    { ...BASH, csrg_path: "/steps/[0]/action", csrg_proof: "{not-json}", csrg_value_digest: "abc" },
    config
  );
  assertDenied(output, /invalid json/i);
});

test("with a confirmed policy, a failed verify-step still denies the tool", async () => {
  const token = {
    jwtToken: "jwt",
    plan: PLAN,
    step_proofs: [{ path: "/steps/[0]/action", proof: [{ position: "left", sibling_hash: "s0" }] }],
  };
  const config = await confirmedPolicySession(
    { csrgVerifyEnabled: true, verifyStepEndpoint: "http://127.0.0.1:9/iap/verify-step" },
    { intentTokenRaw: JSON.stringify(token) }
  );
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("verify-step unreachable");
  };
  try {
    assertDenied(
      await handlePreToolUse(BASH, config),
      /verify-step failed: verify-step unreachable/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("with a confirmed policy, an expired token whose refresh fails still denies the tool", async () => {
  const config = await confirmedPolicySession(
    {},
    {
      intentTokenRaw: JSON.stringify({ jwtToken: "jwt", plan: PLAN }),
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    }
  );
  assertDenied(await handlePreToolUse(BASH, config), /intent token expired/);
});
