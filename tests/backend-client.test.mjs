import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  autoRegisterMcp,
  pushProfile,
  pullProfiles,
  syncPolicy,
  syncMcpRegistry,
} from "../scripts/lib/backend-client.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";
import { savePolicyState } from "../scripts/lib/policy.mjs";
import { saveProfile, loadProfile } from "../scripts/lib/policy-profiles.mjs";
import { postJson } from "../scripts/lib/common.mjs";
import { createOutbox, loginTag } from "../scripts/lib/audit-wal.mjs";
import { getSdkClient } from "../scripts/lib/intent.mjs";

// regression: #0010
test("successful authenticated backend calls lift only the matching persisted audit pause", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armor-auth-success-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const backendEndpoint = "http://127.0.0.1:1";
  const apiKey = "ak_test_original_credential_000000";
  const binding = { backend: backendEndpoint, keyId: loginTag(backendEndpoint, apiKey) };
  const options = { dataDir, login: binding.keyId, binding };
  const config = { dataDir, backendEndpoint, apiKey, timeoutMs: 1000 };
  let status = 200;
  t.mock.method(globalThis, "fetch", async () => Response.json({ policy: {} }, { status }));
  const sdkCall = async (cfg) => {
    const client = getSdkClient({ ...cfg, userId: "test-user", agentId: "test-agent" });
    await client.httpClient.get(`${cfg.backendEndpoint}/iap/validate-key`, {
      adapter: async (request) => ({ config: request, status, data: {}, headers: {} }),
    });
  };
  for (const call of [pullProfiles, (cfg) => autoRegisterMcp(cfg, "test-server"), sdkCall]) {
    const wal = createOutbox(options);
    await wal.appendLine({ tool: "Read" });
    await wal.drain(async () => ({ status: 401, body: {} }), { resolveLogin: () => binding });
    for (const other of [
      { ...config, apiKey: "ak_test_other_credential_000000000" },
      { ...config, backendEndpoint: "http://127.0.0.1:2" },
    ]) {
      await call(other);
      assert.equal((await wal.status(() => binding)).undeliverable, 1);
    }
    await postJson(`${backendEndpoint}/health`, {}, {}, 1000);
    assert.equal((await wal.status(() => binding)).undeliverable, 1);
    status = 401;
    await call(config);
    assert.equal((await wal.status(() => binding)).undeliverable, 1);
    status = 200;
    await call(config);
    const recovered = createOutbox(options);
    assert.equal((await recovered.status(() => binding)).undeliverable, 0);
    await recovered.drain(async () => ({ status: 200, body: { failures: [] } }), {
      resolveLogin: () => binding,
    });
    assert.deepEqual(await recovered.readPending(), []);
  }
});

// regression: #0010
test("audit delivery allows the backend's full ten second batch budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reply = Promise.withResolvers();
  let signal;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    signal = init.signal;
    await reply.promise;
    return Response.json({ failures: [] });
  });
  const request = postJson("http://127.0.0.1:1/iap/audit/batch", { rows: [] }, {}, 8000);
  t.mock.timers.tick(10_000);
  assert.equal(signal.aborted, false);
  reply.resolve();
  assert.equal((await request).status, 200);
});

function buildConfig(tmpDir, overrides = {}) {
  return {
    mode: "enforce",
    dataDir: tmpDir,
    policyFile: path.join(tmpDir, "policy.json"),
    runtimeFile: path.join(tmpDir, "runtime.json"),
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
      maxItems: 50,
    },
    ...overrides,
  };
}

async function seedPolicy(config, rules = []) {
  await savePolicyState(config.policyFile, {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
    policy: { rules },
    history: [],
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

test("pullProfiles reads the active org policy", async () => {
  const { server, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: 2, policy: { rules: [] } }));
  });
  try {
    const result = await pullProfiles({
      apiKey: "test-key",
      backendEndpoint: url,
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.profiles.length, 1);
    assert.equal(result.profiles[0].profile.name, "active");
  } finally {
    server.close();
  }
});

test("syncPolicy stages a draft then a proposal", async () => {
  const hits = [];
  const { server, url } = await startMockServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  try {
    const result = await syncPolicy(
      { apiKey: "test-key", backendEndpoint: url, timeoutMs: 5000, orgId: "org-1" },
      {
        version: 3,
        policy: { rules: [{ id: "p1", action: "deny", tool: "Bash" }] },
        updatedAt: "2026-05-26",
      }
    );
    assert.equal(result.ok, true);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].method, "PUT");
    assert.ok(hits[0].path.endsWith("/policies/profiles/draft"));
    assert.deepEqual(hits[0].body.policy, {
      rules: [{ id: "p1", action: "deny", tool: "Bash" }],
    });
    assert.equal(hits[1].method, "POST");
    assert.ok(hits[1].path.endsWith("/policies/profiles/propose"));
  } finally {
    server.close();
  }
});

test("/armor policy sync without apiKey returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config, [{ id: "p1", action: "allow", tool: "*" }]);
  const out = await handleArmorPolicyCommand("/armor policy sync", config);
  assert.ok(out.includes("armoriq login --product armorclaude"));
});

test("/armor policy profile push without apiKey returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor policy profile push my-profile", config);
  assert.ok(out.includes("armoriq login --product armorclaude"));
});

test("/armor policy profile pull without apiKey returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor policy profile pull", config);
  assert.ok(out.includes("armoriq login --product armorclaude"));
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
    assert.ok(out.includes("proposal"));
  } finally {
    server.close();
  }
});

test("/armor policy profile pull with apiKey saves profiles locally", async () => {
  const { server, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        version: 1,
        policy: { rules: [{ id: "o1", action: "deny", tool: "Bash" }] },
      })
    );
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "backend-test-"));
    const config = buildConfig(tmp, { apiKey: "test-key", backendEndpoint: url });
    const out = await handleArmorPolicyCommand("/armor policy profile pull", config);
    assert.ok(out.includes("Pulled 1"));
    const local = await loadProfile(config, "active");
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
    assert.ok(out.includes("staged"));
  } finally {
    server.close();
  }
});
