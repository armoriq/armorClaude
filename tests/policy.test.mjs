import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { handlePreToolUse, handleUserPromptSubmit } from "../scripts/lib/engine.mjs";
import { checkToolAgainstPlan } from "../scripts/lib/intent.mjs";
import { computePolicyHash, evaluatePolicy, loadPolicyState, savePolicyState } from "../scripts/lib/policy.mjs";
import { readJson, writeJson } from "../scripts/lib/fs-store.mjs";

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

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("evaluatePolicy denies matching deny rule", () => {
  const decision = evaluatePolicy({
    policy: {
      rules: [{ id: "policy1", action: "deny", tool: "web_fetch" }],
    },
    toolName: "web_fetch",
    toolParams: { url: "https://example.com" },
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /policy forbid/i);
});

test("savePolicyState persists canonical IR without legacy rules mirror", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const policyFile = path.join(tmp, "policy.json");
  await savePolicyState(policyFile, {
    version: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
    policy: {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "grouped", description: "" },
      defaults: { decision: "deny", conflictResolution: "deny_overrides" },
      statements: [
        {
          id: "allow-read-tools",
          effect: "permit",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", in: ["Read", "Grep", "Glob"] },
          resource: { type: "workspace", scope: "current" },
          conditions: []
        }
      ]
    },
    history: []
  });
  const raw = await readJson(policyFile, null);
  assert.equal(raw.policy.rules, undefined);
  assert.deepEqual(raw.policy.statements[0].action, { type: "tool", in: ["Read", "Grep", "Glob"] });
  const loaded = await loadPolicyState(policyFile);
  assert.equal(loaded.policy.rules, undefined);
  assert.deepEqual(loaded.policy.statements[0].action, { type: "tool", in: ["Read", "Grep", "Glob"] });
});

test("checkToolAgainstPlan rejects tool drift", () => {
  const decision = checkToolAgainstPlan({
    plan: { steps: [{ action: "read_file" }] },
    toolName: "web_fetch",
    toolInput: {},
  });
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /not in plan/i);
});

test("handleUserPromptSubmit no longer processes policy commands (removed for security)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp);
  const output = await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      prompt: "Policy new: block web_fetch for payment data",
    },
    config
  );
  assert.notEqual(output?.decision, "block", "Policy commands should no longer be blocked/processed by UserPromptSubmit");
});

test("handlePreToolUse denies when policy blocks tool", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    config.policyFile,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
      policy: { rules: [{ id: "policy1", action: "deny", tool: "write" }] },
      history: []
    }),
    "utf8"
  );

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-2",
      tool_name: "write",
      tool_input: { file_path: "a.txt" },
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
});

test("handlePreToolUse asks with Claude Code native UI when policy requires approval", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    config.policyFile,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
      policy: { rules: [{ id: "hold-bash", action: "require_approval", tool: "Bash" }] },
      history: []
    }),
    "utf8"
  );

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-hold-bash",
      tool_name: "Bash",
      tool_input: { command: "ls" }
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "ask");
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason || "", /requires approval: hold-bash/);
});

test("handlePreToolUse asks for held read-only tools instead of bypassing policy fast-path", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    config.policyFile,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
      policy: { rules: [{ id: "hold-read", action: "require_approval", tool: "Read" }] },
      history: []
    }),
    "utf8"
  );

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-hold-read",
      tool_name: "Read",
      tool_input: { file_path: "README.md" }
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "ask");
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason || "", /requires approval: hold-read/);
});

test("handlePreToolUse lets Claude coordination tools bypass user policy default deny", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    config.policyFile,
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
      policy: {
        schemaVersion: "armor.policy.v1",
        kind: "PolicyProfile",
        metadata: { name: "default-deny", description: "" },
        defaults: { decision: "deny", conflictResolution: "deny_overrides" },
        statements: []
      },
      history: []
    }),
    "utf8"
  );

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-toolsearch-default-deny",
      tool_name: "ToolSearch",
      tool_input: { query: "anything" }
    },
    config
  );
  assert.equal(output, null);
});

test("handlePreToolUse blocks direct policy file writes before policy/intent checks", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { intentRequired: false });
  const targets = [
    { tool_name: "Write", tool_input: { file_path: config.policyFile } },
    { tool_name: "Edit", tool_input: { file_path: path.join(tmp, "crypto-policy-state.json") } },
  ];
  for (const target of targets) {
    const output = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "policy-write-guard",
        ...target
      },
      config
    );
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(output?.hookSpecificOutput?.permissionDecisionReason || "", /direct modification/i);
  }
});

test("handlePreToolUse blocks Bash policy-management bypasses", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { intentRequired: false });
  const commands = [
    `echo '{}' > ${config.policyFile}`,
    "node -e \"import('./scripts/lib/armor-policy-commands.mjs').then(m => m.handleArmorPolicyCommand('/armor policy reset', {}))\"",
    "node -e \"import('./scripts/lib/policy.mjs').then(m => m.savePolicyState('policy.json', {}))\"",
  ];
  for (const command of commands) {
    const output = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "policy-bash-guard",
        tool_name: "Bash",
        tool_input: { command }
      },
      config
    );
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  }
});

test("handlePreToolUse denies IR Bash program forbids with env-prefixed command", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { intentRequired: false });
  await writeJson(config.policyFile, {
    version: 1,
    updatedAt: new Date().toISOString(),
    policy: {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "bash-deny", description: "" },
      defaults: { decision: "deny", conflictResolution: "deny_overrides" },
      statements: [
        {
          id: "allow-ls",
          effect: "permit",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", eq: "Bash" },
          resource: { type: "workspace", scope: "current" },
          conditions: [
            { field: "bash.program", op: "in", value: ["ls"] },
            { field: "bash.hasWriteRedirection", op: "eq", value: false }
          ]
        },
        {
          id: "deny-psql-gcloud",
          effect: "forbid",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", eq: "Bash" },
          resource: { type: "workspace", scope: "current" },
          conditions: [{ field: "bash.program", op: "in", value: ["psql", "gcloud"] }]
        }
      ]
    },
    history: []
  });
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "policy-bash-ir-deny",
      tool_name: "Bash",
      tool_input: {
        command: "PGPASSWORD='secret' psql -h 127.0.0.1 -U postgres -d app -c \"\\dt\""
      }
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason || "", /deny-psql-gcloud/);
});

test("handlePreToolUse invalidates stale intent token when policy hash changes before verify-step", async () => {
  let verifyCalled = false;
  const { server, url } = await startMockServer((req, res) => {
    verifyCalled = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ allowed: false, reason: "stale token should not be verified" }));
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
    const config = buildConfig(tmp, {
      intentRequired: false,
      verifyStepEndpoint: `${url}/iap/verify-step`,
      csrgVerifyEnabled: true
    });
    await writeJson(config.policyFile, {
      version: 2,
      updatedAt: new Date().toISOString(),
      policy: {
        schemaVersion: "armor.policy.v1",
        kind: "PolicyProfile",
        metadata: { name: "allow-bash", description: "" },
        defaults: { decision: "deny", conflictResolution: "deny_overrides" },
        statements: [
          {
            id: "allow-all-bash",
            effect: "permit",
            principal: { type: "agent", id: "claude-code" },
            action: { type: "tool", eq: "Bash" },
            resource: { type: "workspace", scope: "current" },
            conditions: []
          }
        ]
      },
      history: []
    });
    await writeJson(config.runtimeFile, {
      sessions: {
        stale: {
          intentTokenRaw: JSON.stringify({ tokenId: "old", plan: { steps: [{ action: "Bash" }] } }),
          policyHash: "old-policy-hash",
          intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
          expiresAt: Math.floor(Date.now() / 1000) + 600
        }
      },
      mcpRegistry: {}
    });

    const output = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "stale",
        tool_name: "Bash",
        intentTokenRaw: JSON.stringify({ tokenId: "old-from-resumed-input", plan: { steps: [{ action: "Bash" }] } }),
        tool_input: { command: "psql -c '\\dt'" }
      },
      config
    );
    assert.equal(output, null);
    assert.equal(verifyCalled, false);
  } finally {
    server.close();
  }
});

test("handlePreToolUse invalidates tokens minted by an old intent policy compiler", async () => {
  let verifyCalled = false;
  const { server, url } = await startMockServer((req, res) => {
    verifyCalled = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ allowed: false, reason: "old compiler token should not be verified" }));
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
    const config = buildConfig(tmp, {
      intentRequired: false,
      verifyStepEndpoint: `${url}/iap/verify-step`,
      csrgVerifyEnabled: true
    });
    const policy = {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "allow-bash", description: "" },
      defaults: { decision: "deny", conflictResolution: "deny_overrides" },
      statements: [
        {
          id: "allow-all-bash",
          effect: "permit",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", eq: "Bash" },
          resource: { type: "workspace", scope: "current" },
          conditions: []
        }
      ]
    };
    const policyHash = computePolicyHash({ ...policy, rules: [{ id: "allow-all-bash", action: "allow", tool: "Bash" }] });
    await writeJson(config.policyFile, { version: 1, updatedAt: new Date().toISOString(), policy, history: [] });
    await writeJson(config.runtimeFile, {
      sessions: {
        oldCompiler: {
          intentTokenRaw: JSON.stringify({ jwtToken: "old", plan: { steps: [{ action: "Bash" }] } }),
          plan: { steps: [{ action: "Bash" }] },
          policyHash,
          expiresAt: Math.floor(Date.now() / 1000) + 600
        }
      },
      mcpRegistry: {}
    });

    const output = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "oldCompiler",
        tool_name: "Bash",
        tool_input: { command: "psql -c '\\dt'" }
      },
      config
    );
    assert.equal(output, null);
    assert.equal(verifyCalled, false);
    const runtime = await readJson(config.runtimeFile, {});
    assert.equal(runtime.sessions.oldCompiler.intentPolicyCompilerVersion, "sdk-csrg-policy-v1");
    assert.equal(runtime.sessions.oldCompiler.intentTokenRaw, "");
  } finally {
    server.close();
  }
});

test("handlePreToolUse reports remote IAP policy validation denials distinctly", async () => {
  const { server, url } = await startMockServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      allowed: false,
      reason: "Policy denied path /steps/[0]/tool",
      policyValidation: {
        decision_source: "native",
        denied_tools: ["Bash"],
        allowed_tools: ["Read"],
        matched_policies: []
      }
    }));
  });
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
    const config = buildConfig(tmp, {
      intentRequired: false,
      verifyStepEndpoint: `${url}/iap/verify-step`,
      csrgVerifyEnabled: true,
      requireCsrgProofs: false
    });
    const policy = {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "allow-bash", description: "" },
      defaults: { decision: "deny", conflictResolution: "deny_overrides" },
      statements: [
        {
          id: "allow-all-bash",
          effect: "permit",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", eq: "Bash" },
          resource: { type: "workspace", scope: "current" },
          conditions: []
        }
      ]
    };
    const policyHash = computePolicyHash({ ...policy, rules: [{ id: "allow-all-bash", action: "allow", tool: "Bash" }] });
    const plan = { steps: [{ action: "Bash" }], metadata: { goal: "db check" } };
    await writeJson(config.policyFile, { version: 1, updatedAt: new Date().toISOString(), policy, history: [] });
    await writeJson(config.runtimeFile, {
      sessions: {
        remote: {
          intentTokenRaw: JSON.stringify({
            jwtToken: "jwt-abc",
            plan,
            policyValidation: { decision_source: "native", denied_tools: ["Bash"] }
          }),
          plan,
          policyHash,
          intentPolicyCompilerVersion: "sdk-csrg-policy-v1",
          expiresAt: Math.floor(Date.now() / 1000) + 600
        }
      },
      mcpRegistry: {}
    });

    const output = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "remote",
        tool_name: "Bash",
        tool_input: { command: "psql -c '\\dt'" }
      },
      config
    );
    const reason = output?.hookSpecificOutput?.permissionDecisionReason || "";
    assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(reason, /remote IAP verify-step denied Bash/);
    assert.match(reason, /backend token\/step verification layer denied/);
    assert.match(reason, /denied_tools=Bash/);
  } finally {
    server.close();
  }
});

test("handlePreToolUse denies missing intent when strict", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  // Use Edit (mutating, NOT in the Phase 4 A1 read-only fast-path) so the
  // full intent-required pipeline runs. Read/Grep/Glob/WebSearch/etc are
  // intentionally fast-pathed and bypass this check by design.
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-3",
      tool_name: "edit",
      tool_input: { file_path: "a.txt", old_string: "x", new_string: "y" },
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(output?.hookSpecificOutput?.permissionDecisionReason || "", /intent plan missing/i);
});

test("Phase 4 A3: deny output for missing plan includes a register_intent_plan hint", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-a3-missing-"));
  const config = buildConfig(tmp, { intentRequired: true });
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "session-a3-1",
      tool_name: "edit",
      tool_input: { file_path: "x.txt", old_string: "a", new_string: "b" },
    },
    config
  );
  const reason = output?.hookSpecificOutput?.permissionDecisionReason || "";
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(reason, /register_intent_plan/, "reason should reference register_intent_plan");
  assert.match(reason, /```json/, "reason should include a JSON code block");
  assert.match(
    reason,
    /"action":\s*"edit"/,
    "reason should include the blocked tool in the suggestion"
  );
});

test("Phase 4 A3: deny on drift extends the existing plan in the hint", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-a3-drift-"));
  const config = buildConfig(tmp, { intentRequired: true });
  const { writeFile } = await import("node:fs/promises");
  // Local-plan-only path (no intentTokenRaw) so the local drift check fires
  // and returns the actionable hint that extends the cached plan.
  await writeFile(
    config.runtimeFile,
    JSON.stringify({
      sessions: {
        "drift-1": {
          plan: { goal: "the original task", steps: [{ action: "Read" }] },
          allowedActions: ["read"],
          lastPrompt: "the original task",
        },
      },
    })
  );
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "drift-1",
      tool_name: "edit",
      tool_input: { file_path: "y.txt", old_string: "a", new_string: "b" },
    },
    config
  );
  const reason = output?.hookSpecificOutput?.permissionDecisionReason || "";
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(reason, /register_intent_plan/);
  // The hint should preserve the existing Read step AND add the new edit step
  assert.match(reason, /"action":\s*"Read"/);
  assert.match(reason, /"action":\s*"edit"/);
});

test("handlePreToolUse fast-paths read-only tools without intent (Phase 4 A1)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  for (const tool of ["read", "grep", "glob", "websearch", "webfetch", "exitplanmode"]) {
    const output = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "session-fastpath",
        tool_name: tool,
        tool_input: {},
      },
      config
    );
    assert.equal(
      output,
      null,
      `${tool} should be fast-pathed (no plan check); got ${JSON.stringify(output)}`
    );
  }
});

test("handlePreToolUse allows tool when local plan matches (no backend)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  // Seed a local plan as if register_intent_plan had been called
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    config.runtimeFile,
    JSON.stringify({
      sessions: {
        "local-1": {
          plan: { steps: [{ action: "Read" }], metadata: { goal: "read x" } },
          allowedActions: ["read"],
          updatedAt: Math.floor(Date.now() / 1000),
        },
      },
    }),
    "utf8"
  );
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "local-1",
      tool_name: "Read",
      tool_input: { file_path: "x.txt" },
    },
    config
  );
  assert.equal(output, null);
});

test("handlePreToolUse denies drift when local plan exists (no backend)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    config.runtimeFile,
    JSON.stringify({
      sessions: {
        "local-2": {
          plan: { steps: [{ action: "Read" }], metadata: { goal: "read x" } },
          allowedActions: ["read"],
          updatedAt: Math.floor(Date.now() / 1000),
        },
      },
    }),
    "utf8"
  );
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "local-2",
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

test("handlePreToolUse replaces stale local plan with fresh pending-plan.json", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { intentRequired: true });
  const { writeFile } = await import("node:fs/promises");
  // Seed an old "Read"-only plan in the session
  await writeFile(
    config.runtimeFile,
    JSON.stringify({
      sessions: {
        "multi-1": {
          plan: { steps: [{ action: "Read" }], metadata: { goal: "old read" } },
          allowedActions: ["read"],
          updatedAt: Math.floor(Date.now() / 1000),
        },
      },
    }),
    "utf8"
  );
  // Drop a NEW pending plan that allows Bash (simulates register_intent_plan)
  await writeFile(
    path.join(tmp, "pending-plan.json"),
    JSON.stringify({
      plan: { steps: [{ action: "Bash" }], metadata: { goal: "list etc" } },
      tokenRaw: "",
      allowedActions: ["bash"],
      registeredAt: Date.now(),
    }),
    "utf8"
  );
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "multi-1",
      tool_name: "Bash",
      tool_input: { command: "ls /etc" },
    },
    config
  );
  assert.equal(output, null, "Bash should be allowed under the freshly registered plan");
  const runtime = await readJson(config.runtimeFile, {});
  assert.equal(typeof runtime.sessions["multi-1"].policyHash, "string");
  assert.ok(runtime.sessions["multi-1"].policyHash.length > 20);
});

test("handleUserPromptSubmit no longer injects policy_update hints (removed for security)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { planningEnabled: true });
  const output = await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-4",
      prompt: "summarize this file",
    },
    config
  );
  const ctx = output?.hookSpecificOutput?.additionalContext || "";
  assert.ok(!ctx.includes("policy_update"), "context hints must not reference policy_update");
});
