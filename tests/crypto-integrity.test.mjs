import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";
import { computePolicyHash, savePolicyState } from "../scripts/lib/policy.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { readJson } from "../scripts/lib/fs-store.mjs";

function buildConfig(tmpDir, overrides = {}) {
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
    timeoutMs: 2000,
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
    mcpDenyByDefault: true,
    enforcementEngine: "local",
    opaPdpUrl: "",
    opaCacheTtlMs: 10000,
    opaTimeoutMs: 3000,
    opaCircuitBreakerThreshold: 15,
    opaCircuitResetMs: 10000,
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

async function seedPolicy(config, rules = []) {
  await savePolicyState(config.policyFile, {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
    policy: { rules },
    history: []
  });
}

function startMockCsrg(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Config: cryptoPolicyEnabled auto-enables with apiKey
// ---------------------------------------------------------------------------

test("loadConfig auto-enables cryptoPolicyEnabled when apiKey is set", () => {
  const config = loadConfig({
    CLAUDE_PLUGIN_OPTION_API_KEY: "test-key-1234567890",
    ARMORIQ_ENV: "development"
  });
  assert.equal(config.cryptoPolicyEnabled, true);
});

test("loadConfig: cryptoPolicyEnabled is tied to apiKey presence", () => {
  const config = loadConfig({ ARMORIQ_ENV: "development" });
  assert.equal(config.cryptoPolicyEnabled, Boolean(config.apiKey));
});

// ---------------------------------------------------------------------------
// /armor-policy confirm with crypto enabled
// ---------------------------------------------------------------------------

test("confirm issues crypto policy token when cryptoPolicyEnabled and CSRG reachable", async () => {
  let csrgCalled = false;
  const { server, url } = await startMockCsrg((req, res) => {
    csrgCalled = true;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        token: "mock-token",
        policy_digest: "mock-digest",
        step_proofs: []
      }));
    });
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "crypto-test-"));
    const config = buildConfig(tmp, {
      cryptoPolicyEnabled: true,
      csrgEndpoint: url
    });
    await seedPolicy(config);

    await handleArmorPolicyCommand("/armor-policy add deny Bash", config);
    const out = await handleArmorPolicyCommand("/armor-policy confirm", config);
    assert.ok(csrgCalled, "CSRG should have been called for token issuance");
    assert.ok(out.includes("Crypto policy token issued"));

    const cryptoState = await readJson(path.join(tmp, "crypto-policy-state.json"), null);
    assert.ok(cryptoState, "Crypto state should be persisted");
    assert.ok(cryptoState.policyDigest);
    const policyState = await readJson(config.policyFile, null);
    assert.equal(cryptoState.policyDigest, computePolicyHash(policyState.policy));
  } finally {
    server.close();
  }
});

test("confirm gracefully handles crypto token failure", async () => {
  const { server, url } = await startMockCsrg((req, res) => {
    res.writeHead(500);
    res.end("Internal Server Error");
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "crypto-test-"));
    const config = buildConfig(tmp, {
      cryptoPolicyEnabled: true,
      csrgEndpoint: url
    });
    await seedPolicy(config);

    await handleArmorPolicyCommand("/armor-policy add deny Bash", config);
    const out = await handleArmorPolicyCommand("/armor-policy confirm", config);
    assert.ok(out.includes("Policy updated"));
    assert.ok(out.includes("crypto token issuance failed"));
  } finally {
    server.close();
  }
});

test("confirm does not attempt crypto when cryptoPolicyEnabled is false", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "crypto-test-"));
  const config = buildConfig(tmp, { cryptoPolicyEnabled: false });
  await seedPolicy(config);

  await handleArmorPolicyCommand("/armor-policy add deny Bash", config);
  const out = await handleArmorPolicyCommand("/armor-policy confirm", config);
  assert.ok(out.includes("Policy updated"));
  assert.ok(!out.includes("Crypto"));
  assert.ok(!out.includes("crypto"));
});

// ---------------------------------------------------------------------------
// OPA mode: confirm pushes to backend
// ---------------------------------------------------------------------------

test("confirm pushes to backend in OPA mode", async () => {
  let syncCalled = false;
  const { server, url } = await startMockCsrg((req, res) => {
    if (req.url?.includes("/policies/sync")) syncCalled = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "crypto-test-"));
    const config = buildConfig(tmp, {
      enforcementEngine: "opa",
      apiKey: "test-key",
      backendEndpoint: url
    });
    await seedPolicy(config);

    await handleArmorPolicyCommand("/armor-policy add deny Bash", config);
    await handleArmorPolicyCommand("/armor-policy confirm", config);
    assert.ok(syncCalled, "Backend should have been called for OPA sync");
  } finally {
    server.close();
  }
});
