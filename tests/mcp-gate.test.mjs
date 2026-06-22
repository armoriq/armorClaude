import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseToolIdentity,
  getMcpServerStatus,
  setMcpServerStatus,
  listMcpServers,
} from "../scripts/lib/tool-registry.mjs";
import { handlePreToolUse } from "../scripts/lib/engine.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";
import { loadRuntimeState, saveRuntimeState } from "../scripts/lib/runtime-state.mjs";

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

// ---------------------------------------------------------------------------
// parseToolIdentity
// ---------------------------------------------------------------------------

test("parseToolIdentity: builtin tools", () => {
  assert.equal(parseToolIdentity("Read").category, "builtin");
  assert.equal(parseToolIdentity("Bash").category, "builtin");
  assert.equal(parseToolIdentity("Edit").category, "builtin");
  assert.equal(parseToolIdentity("Write").category, "builtin");
});

test("parseToolIdentity: ArmorClaude's own MCP tools", () => {
  const r1 = parseToolIdentity("mcp__armorclaude-policy__register_intent_plan");
  assert.equal(r1.category, "armorclaude-own");
  assert.equal(r1.toolName, "register_intent_plan");

  const r2 = parseToolIdentity("mcp__plugin_armorclaude_armorclaude-policy__policy_read");
  assert.equal(r2.category, "armorclaude-own");
  assert.equal(r2.toolName, "policy_read");
});

test("parseToolIdentity: external MCP tools", () => {
  const r = parseToolIdentity("mcp__github__create_issue");
  assert.equal(r.category, "external-mcp");
  assert.equal(r.serverName, "github");
  assert.equal(r.toolName, "create_issue");
});

test("parseToolIdentity: plugin MCP tools", () => {
  const r = parseToolIdentity("mcp__plugin_myco_slack__send_message");
  assert.equal(r.category, "plugin-mcp");
  assert.equal(r.serverName, "slack");
  assert.equal(r.toolName, "send_message");
  assert.equal(r.pluginName, "myco");
});

test("parseToolIdentity: Skill tool", () => {
  assert.equal(parseToolIdentity("Skill").category, "skill");
});

test("parseToolIdentity: handles null/empty", () => {
  assert.equal(parseToolIdentity(null).category, "unknown");
  assert.equal(parseToolIdentity("").category, "unknown");
});

// ---------------------------------------------------------------------------
// MCP registry helpers
// ---------------------------------------------------------------------------

test("getMcpServerStatus returns null for unknown server", () => {
  const state = { sessions: {}, mcpRegistry: {} };
  assert.equal(getMcpServerStatus(state, "github"), null);
});

test("setMcpServerStatus + getMcpServerStatus round-trip", () => {
  const state = { sessions: {}, mcpRegistry: {} };
  setMcpServerStatus(state, "github", "approved");
  const entry = getMcpServerStatus(state, "github");
  assert.equal(entry.status, "approved");
  assert.equal(entry.serverName, "github");
});

test("listMcpServers returns all registered servers", () => {
  const state = { sessions: {}, mcpRegistry: {} };
  setMcpServerStatus(state, "github", "approved");
  setMcpServerStatus(state, "slack", "denied");
  const servers = listMcpServers(state);
  assert.equal(servers.length, 2);
});

// ---------------------------------------------------------------------------
// PreToolUse: MCP deny-by-default
// ---------------------------------------------------------------------------

test("handlePreToolUse asks before running an unknown external MCP tool", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "mcp-1",
      tool_name: "mcp__github__create_issue",
      tool_input: { title: "test" },
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "ask");
  assert.ok(output?.hookSpecificOutput?.permissionDecisionReason?.includes("not approved"));
  assert.ok(output?.hookSpecificOutput?.permissionDecisionReason?.includes("/armor mcp approve"));
});

test("handlePreToolUse denies explicitly denied MCP server", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);
  const rtState = await loadRuntimeState(config.runtimeFile);
  setMcpServerStatus(rtState, "evil-server", "denied");
  await saveRuntimeState(config.runtimeFile, rtState);

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "mcp-2",
      tool_name: "mcp__evil-server__steal_data",
      tool_input: {},
    },
    config
  );
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
});

test("handlePreToolUse allows approved MCP server tool", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);
  const rtState = await loadRuntimeState(config.runtimeFile);
  setMcpServerStatus(rtState, "github", "approved");
  await saveRuntimeState(config.runtimeFile, rtState);

  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "mcp-3",
      tool_name: "mcp__github__create_issue",
      tool_input: { title: "test" },
    },
    config
  );
  assert.notEqual(
    output?.hookSpecificOutput?.permissionDecision,
    "deny",
    "Approved MCP server tools should not be denied by the MCP gate"
  );
});

test("handlePreToolUse still allows ArmorClaude's own MCP tools", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "mcp-4",
      tool_name: "mcp__armorclaude-policy__register_intent_plan",
      tool_input: {},
    },
    config
  );
  assert.equal(output, null);
});

test("handlePreToolUse allows builtin tools through MCP gate", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "mcp-5",
      tool_name: "Read",
      tool_input: { file_path: "test.txt" },
    },
    config
  );
  assert.equal(output, null, "Read is a safe builtin, should pass through");
});

test("MCP gate registers pending server on first encounter", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);
  await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "mcp-6",
      tool_name: "mcp__new-server__some_tool",
      tool_input: {},
    },
    config
  );
  const rtState = await loadRuntimeState(config.runtimeFile);
  const entry = getMcpServerStatus(rtState, "new-server");
  assert.ok(entry);
  assert.equal(entry.status, "pending");
});

test("MCP gate is disabled when mcpDenyByDefault is false", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp, { mcpDenyByDefault: false });
  const output = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "mcp-7",
      tool_name: "mcp__unknown-server__some_tool",
      tool_input: {},
    },
    config
  );
  assert.notEqual(
    output?.hookSpecificOutput?.permissionDecision,
    "deny",
    "MCP gate should not deny when mcpDenyByDefault is false"
  );
});

// ---------------------------------------------------------------------------
// /armor policy mcp commands
// ---------------------------------------------------------------------------

test("/armor policy mcp list shows no servers initially", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor policy mcp list", config);
  assert.ok(out.includes("No MCP servers"));
});

test("/armor policy mcp approve + list shows approved server", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);
  const approveOut = await handleArmorPolicyCommand("/armor policy mcp approve github", config);
  assert.ok(approveOut.includes("approved"));

  const listOut = await handleArmorPolicyCommand("/armor policy mcp list", config);
  assert.ok(listOut.includes("github"));
  assert.ok(listOut.includes("approved"));
});

test("/armor policy mcp deny blocks server", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);
  const denyOut = await handleArmorPolicyCommand("/armor policy mcp deny evil-server", config);
  assert.ok(denyOut.includes("denied"));

  const listOut = await handleArmorPolicyCommand("/armor policy mcp list", config);
  assert.ok(listOut.includes("evil-server"));
  assert.ok(listOut.includes("denied"));
});

test("end-to-end: unknown MCP asks → approve → tool allowed", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mcp-gate-test-"));
  const config = buildConfig(tmp);

  const ask1 = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "e2e-1",
      tool_name: "mcp__github__list_repos",
      tool_input: {},
    },
    config
  );
  assert.equal(ask1?.hookSpecificOutput?.permissionDecision, "ask");

  await handleArmorPolicyCommand("/armor policy mcp approve github", config);

  const allow = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "e2e-1",
      tool_name: "mcp__github__list_repos",
      tool_input: {},
    },
    config
  );
  assert.notEqual(allow?.hookSpecificOutput?.permissionDecision, "deny");
});
