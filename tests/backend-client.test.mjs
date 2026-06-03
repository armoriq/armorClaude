import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { autoRegisterMcp, pushProfile, pullProfiles, syncPolicy, syncMcpRegistry } from "../scripts/lib/backend-client.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";
import { savePolicyState } from "../scripts/lib/policy.mjs";
import { saveProfile, loadProfile } from "../scripts/lib/policy-profiles.mjs";

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

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Backend client: no-backend graceful fallback
// ---------------------------------------------------------------------------

test("autoRegisterMcp returns error when no apiKey", async () => {
  const result = await autoRegisterMcp({ apiKey: "", backendEndpoint: "http://x" }, "github");
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("no backend"));
});

test("pushProfile returns error when no apiKey", async () => {
  const result = await pushProfile({ apiKey: "", backendEndpoint: "http://x" }, {});
  assert.equal(result.ok, false);
});

test("pullProfiles returns error when no apiKey", async () => {
  const result = await pullProfiles({ apiKey: "", backendEndpoint: "http://x" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.profiles, []);
});

test("syncPolicy returns error when no apiKey", async () => {
  const result = await syncPolicy({ apiKey: "", backendEndpoint: "http://x" }, {});
  assert.equal(result.ok, false);
});

test("syncMcpRegistry returns error when no apiKey", async () => {
  const result = await syncMcpRegistry({ apiKey: "", backendEndpoint: "http://x" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.servers, []);
});

// ---------------------------------------------------------------------------
// Backend client: with mock server
// ---------------------------------------------------------------------------

test("autoRegisterMcp sends POST to /mcp/auto-register", async () => {
  let receivedBody = null;
  const { server, url } = await startMockServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const result = await autoRegisterMcp(
      { apiKey: "test-key", backendEndpoint: url, timeoutMs: 5000 },
      "github"
    );
    assert.equal(result.ok, true);
    assert.equal(receivedBody.mcpName, "github");
    assert.equal(receivedBody.source, "armorclaude-autodetect");
  } finally {
    server.close();
  }
});

test("pullProfiles parses backend response", async () => {
  const mockProfiles = [
    { profile: { name: "org-lockdown", description: "Org lockdown" }, version: 1, policy: { rules: [] } }
  ];
  const { server, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ profiles: mockProfiles }));
  });
  try {
    const result = await pullProfiles({ apiKey: "test-key", backendEndpoint: url, timeoutMs: 5000 });
    assert.equal(result.ok, true);
    assert.equal(result.profiles.length, 1);
    assert.equal(result.profiles[0].profile.name, "org-lockdown");
  } finally {
    server.close();
  }
});

test("syncPolicy sends policy state to /policies/sync", async () => {
  let receivedBody = null;
  const { server, url } = await startMockServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      receivedBody = JSON.parse(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const result = await syncPolicy(
      { apiKey: "test-key", backendEndpoint: url, timeoutMs: 5000 },
      { version: 3, policy: { rules: [{ id: "p1", action: "deny", tool: "Bash" }] }, updatedAt: "2026-05-26" }
    );
    assert.equal(result.ok, true);
    assert.equal(receivedBody.version, 3);
    assert.equal(receivedBody.source, "armorclaude");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// /armor policy command wiring
// ---------------------------------------------------------------------------

test("/armor policy sync without apiKey returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config, [{ id: "p1", action: "allow", tool: "*" }]);
  const out = await handleArmorPolicyCommand("/armor policy sync", config);
  assert.ok(out.includes("API key"));
});

test("/armor policy profile push without apiKey returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor policy profile push my-profile", config);
  assert.ok(out.includes("API key"));
});

test("/armor policy profile pull without apiKey returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor policy profile pull", config);
  assert.ok(out.includes("API key"));
});

test("/armor policy profile push with apiKey sends to backend", async () => {
  let received = false;
  const { server, url } = await startMockServer((req, res) => {
    received = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
    const config = buildConfig(tmp, { apiKey: "test-key", backendEndpoint: url });
    await saveProfile(config, "my-profile", "test", [{ id: "p1", action: "allow", tool: "*" }]);
    const out = await handleArmorPolicyCommand("/armor policy profile push my-profile", config);
    assert.ok(received, "Backend should have received the request");
    assert.ok(out.includes("pushed"));
  } finally {
    server.close();
  }
});

test("/armor policy profile pull with apiKey saves profiles locally", async () => {
  const mockProfiles = [
    { profile: { name: "from-org", description: "Org profile" }, version: 1, policy: { rules: [{ id: "o1", action: "deny", tool: "Bash" }] } }
  ];
  const { server, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ profiles: mockProfiles }));
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
    const config = buildConfig(tmp, { apiKey: "test-key", backendEndpoint: url });
    const out = await handleArmorPolicyCommand("/armor policy profile pull", config);
    assert.ok(out.includes("Pulled 1"));
    const local = await loadProfile(config, "from-org");
    assert.ok(local);
    assert.equal(local.policy.rules, undefined);
    assert.equal(local.rules, undefined);
    assert.equal(local.policy.statements[0].id, "o1");
  } finally {
    server.close();
  }
});

test("/armor policy sync with apiKey sends to backend", async () => {
  let received = false;
  const { server, url } = await startMockServer((req, res) => {
    received = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
    const config = buildConfig(tmp, { apiKey: "test-key", backendEndpoint: url });
    await seedPolicy(config, [{ id: "p1", action: "deny", tool: "Bash" }]);
    const out = await handleArmorPolicyCommand("/armor policy sync", config);
    assert.ok(received);
    assert.ok(out.includes("synced"));
  } finally {
    server.close();
  }
});
