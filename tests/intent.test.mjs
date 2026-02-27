import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { handlePreToolUse } from "../scripts/lib/engine.mjs";
import {
  parseCsrgProofHeaders,
  resolveCsrgProofsFromToken,
  verifyStep
} from "../scripts/lib/intent.mjs";

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
    apiKey: "ak_test_12345678",
    useSdkIntent: false,
    intentEndpoint: "",
    verifyStepEndpoint: "",
    validitySeconds: 60,
    timeoutMs: 5000,
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

test("parseCsrgProofHeaders rejects invalid JSON proof header", () => {
  const parsed = parseCsrgProofHeaders({
    csrg_path: "/steps/[0]/action",
    csrg_proof: "{not-json}",
    csrg_value_digest: "abc"
  });
  assert.match(parsed.error || "", /invalid json/i);
});

test("resolveCsrgProofsFromToken selects param-matched step for duplicate tools", () => {
  const plan = {
    steps: [
      { action: "write", metadata: { inputs: { file_path: "a.txt" } } },
      { action: "write", metadata: { inputs: { file_path: "b.txt" } } }
    ]
  };
  const token = {
    plan,
    step_proofs: [
      {
        path: "/steps/[0]/action",
        proof: [{ position: "left", sibling_hash: "aaa" }]
      },
      {
        path: "/steps/[1]/action",
        proof: [{ position: "left", sibling_hash: "bbb" }]
      }
    ]
  };
  const resolved = resolveCsrgProofsFromToken({
    intentTokenRaw: JSON.stringify(token),
    plan,
    toolName: "write",
    toolParams: { file_path: "b.txt" },
    usedStepIndices: new Set()
  });
  assert.equal(resolved?.stepIndex, 1);
  assert.equal(resolved?.path, "/steps/[1]/action");
});

test("verifyStep sends armorIQ verify-step payload with jwt token and CSRG context", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcowork-test-"));
  const config = buildConfig(tmp, { verifyStepEndpoint: "https://example.test/iap/verify-step" });
  const originalFetch = globalThis.fetch;
  let capturedPayload = null;
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ allowed: true, reason: "ok", step: { step_index: 2 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const result = await verifyStep(config, {
      intentTokenRaw: JSON.stringify({
        jwtToken: "jwt-token-abc",
        plan: { steps: [{ action: "read" }] }
      }),
      toolName: "read",
      csrgProofs: {
        path: "/steps/[2]/action",
        proof: [{ position: "left", sibling_hash: "abc" }],
        valueDigest: "deadbeef"
      }
    });
    assert.equal(capturedPayload.token, "jwt-token-abc");
    assert.equal(capturedPayload.tool_name, "read");
    assert.equal(capturedPayload.path, "/steps/[2]/action");
    assert.equal(capturedPayload.step_index, 2);
    assert.equal(capturedPayload.context.csrg_value_digest, "deadbeef");
    assert.equal(result.allowed, true);
    assert.equal(result.stepIndex, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handlePreToolUse resolves CSRG proofs from token step_proofs across duplicate tools", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorcowork-test-"));
  const config = buildConfig(tmp, { verifyStepEndpoint: "https://example.test/iap/verify-step" });
  const token = {
    jwtToken: "jwt-token-xyz",
    plan: {
      steps: [
        { action: "write", metadata: { inputs: { file_path: "a.txt" } } },
        { action: "write", metadata: { inputs: { file_path: "b.txt" } } }
      ]
    },
    step_proofs: [
      { path: "/steps/[0]/action", proof: [{ position: "left", sibling_hash: "s0" }] },
      { path: "/steps/[1]/action", proof: [{ position: "left", sibling_hash: "s1" }] }
    ]
  };

  await writeFile(
    config.runtimeFile,
    JSON.stringify(
      {
        sessions: {
          s1: {
            intentTokenRaw: JSON.stringify(token),
            plan: token.plan,
            updatedAt: Math.floor(Date.now() / 1000)
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const originalFetch = globalThis.fetch;
  const seenStepIndices = [];
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    seenStepIndices.push(payload.step_index);
    return new Response(JSON.stringify({ allowed: true, reason: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    const first = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        tool_name: "write",
        tool_input: { file_path: "a.txt" }
      },
      config
    );
    const second = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        tool_name: "write",
        tool_input: { file_path: "b.txt" }
      },
      config
    );

    assert.equal(first, null);
    assert.equal(second, null);
    assert.deepEqual(seenStepIndices, [0, 1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

