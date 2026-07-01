import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { evaluateOpa, resetOpaClientState } from "../scripts/lib/opa-client.mjs";
import { compileToOpaInput, compilePolicyForBundle } from "../scripts/lib/policy-compiler.mjs";
import { handlePreToolUse } from "../scripts/lib/engine.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";
import { savePolicyState } from "../scripts/lib/policy.mjs";

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

function startMockOpa(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// policy-compiler.mjs
// ---------------------------------------------------------------------------

test("compileToOpaInput maps deny rule correctly", () => {
  const input = compileToOpaInput([{ id: "p1", action: "deny", tool: "Bash" }], "Bash", {
    command: "ls",
  });
  assert.equal(input.policies.length, 1);
  assert.equal(input.policies[0].policyId, "p1");
  assert.deepEqual(input.policies[0].clientRule.blockedTools, ["Bash"]);
  assert.equal(input.policies[0].clientRule.enforcementAction, "block");
  assert.equal(input.resource.toolName, "Bash");
});

test("compileToOpaInput maps allow-all rule", () => {
  const input = compileToOpaInput([{ id: "a1", action: "allow", tool: "*" }], "Read", {});
  assert.deepEqual(input.policies[0].clientRule.allowedTools, ["*"]);
  assert.equal(input.policies[0].clientRule.enforcementAction, "allow");
});

test("compileToOpaInput maps require_approval rule", () => {
  const input = compileToOpaInput(
    [{ id: "h1", action: "require_approval", tool: "Write" }],
    "Write",
    {}
  );
  assert.equal(input.policies[0].clientRule.enforcementAction, "hold");
});

test("compilePolicyForBundle produces bundle format", () => {
  const bundle = compilePolicyForBundle([
    { id: "p1", action: "deny", tool: "Bash" },
    { id: "p2", action: "allow", tool: "*" },
  ]);
  assert.equal(bundle.statements.length, 2);
  assert.equal(bundle.rules, undefined);
  assert.equal(bundle.format, "armorclaude-ir-v1");
  assert.ok(bundle.compiledAt);
});

// ---------------------------------------------------------------------------
// opa-client.mjs
// ---------------------------------------------------------------------------

test("evaluateOpa returns error when no PDP URL", async () => {
  resetOpaClientState();
  const result = await evaluateOpa({ opaPdpUrl: "" }, {});
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("not configured"));
});

test("evaluateOpa calls OPA and returns allow decision", async () => {
  resetOpaClientState();
  const { server, url } = await startMockOpa((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { allow: true, reason: "allowed_by_policy" } }));
    });
  });
  try {
    const result = await evaluateOpa(
      { opaPdpUrl: url, opaTimeoutMs: 5000, opaCacheTtlMs: 100 },
      { resource: { toolName: "Read" }, context: {}, policies: [], subject: {} }
    );
    assert.equal(result.allowed, true);
  } finally {
    server.close();
  }
});

test("evaluateOpa returns deny on OPA deny", async () => {
  resetOpaClientState();
  const { server, url } = await startMockOpa((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { allow: false, reason: "blocked_by_policy" } }));
    });
  });
  try {
    const result = await evaluateOpa(
      { opaPdpUrl: url, opaTimeoutMs: 5000, opaCacheTtlMs: 100 },
      { resource: { toolName: "Bash" }, context: {}, policies: [], subject: {} }
    );
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes("blocked_by_policy"));
  } finally {
    server.close();
  }
});

test("evaluateOpa maps OPA hold decision to native approval", async () => {
  const { server, url } = await startMockOpa((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        result: {
          decision: "hold",
          reason: "opa_hold_bash",
          matched_policy: "hold-bash",
        },
      })
    );
  });
  try {
    resetOpaClientState();
    const tmp = await mkdtemp(path.join(os.tmpdir(), "opa-test-"));
    const config = buildConfig(tmp, { enforcementEngine: "opa", opaPdpUrl: url });
    await seedPolicy(config, [{ id: "h1", action: "require_approval", tool: "Bash" }]);

    const output = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "opa-hold",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
      config
    );
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "ask");
    assert.match(output?.hookSpecificOutput?.permissionDecisionReason || "", /opa_hold_bash/);
  } finally {
    server.close();
  }
});

test("evaluateOpa fail-closed on network error", async () => {
  resetOpaClientState();
  const result = await evaluateOpa(
    { opaPdpUrl: "http://127.0.0.1:19999", opaTimeoutMs: 500, opaCacheTtlMs: 100 },
    { resource: { toolName: "Bash" }, context: {}, policies: [], subject: {} }
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("fail-closed"));
});

test("evaluateOpa caches decisions", async () => {
  resetOpaClientState();
  let callCount = 0;
  const { server, url } = await startMockOpa((req, res) => {
    callCount++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { allow: true } }));
    });
  });
  try {
    const cfg = { opaPdpUrl: url, opaTimeoutMs: 5000, opaCacheTtlMs: 60000 };
    const input = { resource: { toolName: "Read" }, context: {}, policies: [], subject: {} };
    await evaluateOpa(cfg, input);
    await evaluateOpa(cfg, input);
    await evaluateOpa(cfg, input);
    assert.equal(callCount, 1, "Should only call OPA once due to caching");
  } finally {
    server.close();
  }
});

test("evaluateOpa circuit breaker opens after threshold failures", async () => {
  resetOpaClientState();
  const cfg = {
    opaPdpUrl: "http://127.0.0.1:19999",
    opaTimeoutMs: 100,
    opaCacheTtlMs: 100,
    opaCircuitBreakerThreshold: 3,
    opaCircuitResetMs: 60000,
  };
  const input = { resource: { toolName: "Bash" }, context: {}, policies: [], subject: {} };
  for (let i = 0; i < 3; i++) {
    await evaluateOpa(cfg, input);
  }
  const result = await evaluateOpa(cfg, input);
  assert.equal(result.allowed, false);
  assert.ok(result.reason.includes("circuit breaker"));
});

// ---------------------------------------------------------------------------
// Engine integration: OPA enforcement mode
// ---------------------------------------------------------------------------

test("handlePreToolUse uses OPA when enforcementEngine=opa", async () => {
  resetOpaClientState();
  const { server, url } = await startMockOpa((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input = JSON.parse(body).input;
      const allow = input.resource.toolName !== "Bash";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { allow, reason: allow ? "ok" : "bash_blocked" } }));
    });
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "opa-test-"));
    const config = buildConfig(tmp, { enforcementEngine: "opa", opaPdpUrl: url });
    await seedPolicy(config, [{ id: "p1", action: "deny", tool: "Bash" }]);

    const denyOutput = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "opa-1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
      config
    );
    assert.equal(denyOutput?.hookSpecificOutput?.permissionDecision, "deny");

    resetOpaClientState();
    const allowOutput = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "opa-1",
        tool_name: "Edit",
        tool_input: { file_path: "x.txt" },
      },
      config
    );
    assert.notEqual(allowOutput?.hookSpecificOutput?.permissionDecision, "deny");
  } finally {
    server.close();
  }
});

test("handlePreToolUse uses local JSON when enforcementEngine=local", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opa-test-"));
  const config = buildConfig(tmp, { enforcementEngine: "local" });
  await seedPolicy(config, [{ id: "p1", action: "deny", tool: "Bash" }]);

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "local-1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
});

test("handlePreToolUse falls back to local when OPA URL not set even if engine=opa", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opa-test-"));
  const config = buildConfig(tmp, { enforcementEngine: "opa", opaPdpUrl: "" });
  await seedPolicy(config, [{ id: "p1", action: "deny", tool: "Bash" }]);

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "fallback-1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
});

// ---------------------------------------------------------------------------
// /armor policy settings commands
// ---------------------------------------------------------------------------

test("/armor policy settings shows current config", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opa-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor policy settings", config);
  assert.ok(out.includes("Enforcement engine"));
  assert.ok(out.includes("local"));
  assert.ok(out.includes("MCP deny-by-default"));
});

test("/armor policy settings enforcement opa without URL returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opa-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor policy settings enforcement opa", config);
  assert.ok(out.includes("Cannot switch"));
});

test("/armor policy settings enforcement local succeeds", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opa-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor policy settings enforcement local", config);
  assert.ok(out.includes("local"));
});

test("/armor policy settings enforcement opa with URL succeeds", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opa-test-"));
  const config = buildConfig(tmp, { opaPdpUrl: "http://localhost:8181" });
  const out = await handleArmorPolicyCommand("/armor policy settings enforcement opa", config);
  assert.ok(out.includes("opa"));
});

test("/armor policy settings unknown returns help", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opa-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor policy settings blah", config);
  assert.ok(out.includes("Unknown setting"));
});
