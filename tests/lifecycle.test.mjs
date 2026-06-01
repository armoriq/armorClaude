/* eslint-disable */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  handleSessionStart,
  handleSessionEnd,
  handleStop,
  handlePostToolUse,
  handlePostToolUseFailure,
  handlePreToolUse,
} from "../scripts/lib/engine.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import {
  upsertSession,
  loadRuntimeState,
  saveRuntimeState,
  getTrustOps,
} from "../scripts/lib/runtime-state.mjs";

function buildConfig(tmpDir, overrides = {}) {
  return {
    mode: "enforce",
    dataDir: tmpDir,
    policyFile: path.join(tmpDir, "policy.json"),
    runtimeFile: path.join(tmpDir, "runtime.json"),
    useProduction: false,
    backendEndpoint: "http://127.0.0.1:3000",
    csrgEndpoint: "http://127.0.0.1:8000",
    apiKey: "",
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
    intentRequired: true,
    requireCsrgProofs: true,
    csrgVerifyEnabled: true,
    policyUpdateEnabled: true,
    policyUpdateAllowList: ["*"],
    contextHintsEnabled: true,
    cryptoPolicyEnabled: false,
    auditEnabled: false,
    planningEnabled: false,
    planningApiKey: "",
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

test("handleSessionStart creates session and returns context", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp);
  const output = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "sess-1", source: "startup" },
    config
  );
  assert.ok(output?.hookSpecificOutput?.additionalContext);
  assert.match(output.hookSpecificOutput.additionalContext, /ArmorClaude active/i);

  // Verify session was persisted
  const stateRaw = await readFile(config.runtimeFile, "utf8");
  const state = JSON.parse(stateRaw);
  assert.ok(state.sessions["sess-1"]);
  assert.ok(state.sessions["sess-1"].startedAt);
});

test("handleSessionEnd removes session", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp);
  // Create session first
  await handleSessionStart({ hook_event_name: "SessionStart", session_id: "sess-2" }, config);
  // End it
  await handleSessionEnd({ hook_event_name: "SessionEnd", session_id: "sess-2" }, config);

  const stateRaw = await readFile(config.runtimeFile, "utf8");
  const state = JSON.parse(stateRaw);
  assert.equal(state.sessions["sess-2"], undefined);
});

test("handleStop returns null", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp);
  await handleSessionStart({ hook_event_name: "SessionStart", session_id: "sess-3" }, config);
  const output = await handleStop({ hook_event_name: "Stop", session_id: "sess-3" }, config);
  assert.equal(output, null);
});

test("handlePostToolUse returns null when audit disabled", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { auditEnabled: false });
  const output = await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: "sess-4",
      tool_name: "Read",
      tool_input: { file_path: "test.txt" },
      tool_response: { content: "hello" },
    },
    config
  );
  assert.equal(output, null);
});

test("handlePostToolUse sends audit when enabled", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { auditEnabled: true, apiKey: "test-key" });
  await handleSessionStart({ hook_event_name: "SessionStart", session_id: "sess-5" }, config);
  // Seed an intent token so the audit DTO carries a non-empty `token`. The
  // PostToolUse handler skips audit when no token is captured (armorclaude#41
  // — empty token previously crashed conmap-auto's Prisma upsert).
  {
    const rs = await loadRuntimeState(config.runtimeFile);
    upsertSession(rs, "sess-5", {
      intentTokenRaw: "test.jwt.token",
      expiresAt: Date.now() / 1000 + 600,
    });
    await saveRuntimeState(config.runtimeFile, rs);
  }

  const originalFetch = globalThis.fetch;
  let capturedPayload;
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ audit_id: "a1", iap_sync_status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const output = await handlePostToolUse(
      {
        hook_event_name: "PostToolUse",
        session_id: "sess-5",
        tool_name: "Read",
        tool_input: { file_path: "test.txt" },
        tool_response: { content: "hello" },
      },
      config
    );
    assert.equal(output, null);
    assert.equal(capturedPayload.action, "Read");
    assert.equal(capturedPayload.status, "success");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handlePostToolUseFailure logs failed status", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-test-"));
  const config = buildConfig(tmp, { auditEnabled: true, apiKey: "test-key" });
  await handleSessionStart({ hook_event_name: "SessionStart", session_id: "sess-6" }, config);
  {
    const rs = await loadRuntimeState(config.runtimeFile);
    upsertSession(rs, "sess-6", {
      intentTokenRaw: "test.jwt.token",
      expiresAt: Date.now() / 1000 + 600,
    });
    await saveRuntimeState(config.runtimeFile, rs);
  }

  const originalFetch = globalThis.fetch;
  let capturedPayload;
  globalThis.fetch = async (_url, options) => {
    capturedPayload = JSON.parse(options.body);
    return new Response(JSON.stringify({ audit_id: "a2", iap_sync_status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await handlePostToolUseFailure(
      {
        hook_event_name: "PostToolUseFailure",
        session_id: "sess-6",
        tool_name: "Bash",
        tool_input: { command: "exit 1" },
        error: "Command failed with exit code 1",
      },
      config
    );
    assert.equal(capturedPayload.status, "failed");
    assert.equal(capturedPayload.error_message, "Command failed with exit code 1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Phase 3 — Trust Update integration: auto-reanchor + auto-revoke
// ---------------------------------------------------------------------------

test("PreToolUse appends ReAnchor trust op when pending plan differs from cached", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-trust-"));
  // useSdkIntent stays false so the wrapper short-circuits with ok=false.
  // We're verifying the *integration* — that engine.mjs detected the plan
  // delta, called reanchorViaSdk, and recorded the op (with ok:false because
  // the SDK wasn't enabled). That's the exact contract for an audit trail.
  const config = buildConfig(tmp, { autoReanchor: true, useSdkIntent: false });

  // Seed prior session with a plan + token.
  const priorState = await loadRuntimeState(config.runtimeFile);
  upsertSession(priorState, "sess-trust-1", {
    intentTokenRaw: JSON.stringify({ tokenId: "tok_abc", plan: { steps: [] } }),
    plan: { goal: "g", steps: [{ action: "echo" }] },
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  await saveRuntimeState(config.runtimeFile, priorState);

  // Stage a new (different) plan via pending-plan.json — same shape the
  // register_intent_plan MCP tool writes.
  await writeFile(
    path.join(tmp, "pending-plan.json"),
    JSON.stringify({
      plan: { goal: "g2", steps: [{ action: "echo" }, { action: "add_step" }] },
      tokenRaw: JSON.stringify({ tokenId: "tok_new", plan: { steps: [] } }),
      allowedActions: ["echo", "add_step"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
  );

  await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "sess-trust-1",
      tool_name: "echo",
      tool_input: { text: "hi" },
    },
    config
  );

  const state = await loadRuntimeState(config.runtimeFile);
  const ops = getTrustOps(state, "sess-trust-1");
  assert.equal(ops.length, 1, "expected exactly one trust op (ReAnchor)");
  assert.equal(ops[0].operation, "ReAnchor");
  assert.ok(ops[0].fromHash, "fromHash should be present");
  assert.ok(ops[0].toHash, "toHash should be present");
  assert.notEqual(ops[0].fromHash, ops[0].toHash, "hashes must differ for plan delta");
  assert.equal(ops[0].ok, false, "ok=false because useSdkIntent disabled");
});

test("PreToolUse does NOT record ReAnchor when pending plan matches cached", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-trust-nodrift-"));
  const config = buildConfig(tmp, { autoReanchor: true, useSdkIntent: false });

  const samePlan = { goal: "g", steps: [{ action: "echo" }] };
  const priorState = await loadRuntimeState(config.runtimeFile);
  upsertSession(priorState, "sess-trust-2", {
    intentTokenRaw: JSON.stringify({ tokenId: "tok_abc", plan: samePlan }),
    plan: samePlan,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  await saveRuntimeState(config.runtimeFile, priorState);

  await writeFile(
    path.join(tmp, "pending-plan.json"),
    JSON.stringify({
      plan: samePlan,
      tokenRaw: JSON.stringify({ tokenId: "tok_same" }),
      allowedActions: ["echo"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    })
  );

  await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "sess-trust-2",
      tool_name: "echo",
      tool_input: {},
    },
    config
  );

  const state = await loadRuntimeState(config.runtimeFile);
  const ops = getTrustOps(state, "sess-trust-2");
  assert.equal(ops.length, 0, "no plan delta, no trust op");
});

// Removed 2026-05-13: the autoReanchor flag is gone (always-on). Setting it
// to false used to skip the reanchor call; now there is no opt-out. The
// always-on path is already covered by the "PreToolUse triggers auto-reanchor"
// test above.

test("SessionEnd invokes client.revoke when autoRevokeOnEnd is true", async () => {
  // We inject a stub directly into the SDK client cache so the test is
  // independent of the installed @armoriq/sdk version. The wrapper resolves
  // `getSdkClient(config)` which reads from this cache — pre-populating it
  // means our stub is called instead of constructing a real ArmorIQClient.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-trust-revoke-"));
  const config = buildConfig(tmp, {
    autoRevokeOnEnd: true,
    useSdkIntent: true,
    apiKey: "ak_test_revoke",
    userId: "test-user-revoke", // unique to dodge cache collisions
    auditEnabled: false,
  });

  const priorState = await loadRuntimeState(config.runtimeFile);
  upsertSession(priorState, "sess-trust-4", {
    intentTokenRaw: JSON.stringify({ tokenId: "tok_to_revoke" }),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  await saveRuntimeState(config.runtimeFile, priorState);

  const calls = [];
  const intentMod = await import("../scripts/lib/intent.mjs");
  // Pre-warm the SDK client cache by calling getSdkClient once and replacing
  // its revoke implementation. Since getSdkClient caches by a config-derived
  // key, subsequent lookups inside the wrapper return the same instance.
  const client = intentMod.getSdkClient(config);
  const originalRevoke = client.revoke;
  client.revoke = async (token, reason) => {
    calls.push({ tokenId: token?.tokenId || token?.token_id, reason });
    return { trustId: "tr_e2e_revoke" };
  };

  try {
    await handleSessionEnd({ hook_event_name: "SessionEnd", session_id: "sess-trust-4" }, config);
  } finally {
    if (originalRevoke) client.revoke = originalRevoke;
    else delete client.revoke;
  }

  assert.equal(calls.length, 1, "client.revoke should fire exactly once on SessionEnd");
  assert.equal(calls[0].tokenId, "tok_to_revoke");
  assert.match(calls[0].reason, /session-ended/);
});

test("SessionEnd does NOT call client.revoke when autoRevokeOnEnd is false", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-trust-norevoke-"));
  const config = buildConfig(tmp, {
    autoRevokeOnEnd: false,
    useSdkIntent: true,
    apiKey: "ak_test_norevoke",
    userId: "test-user-norevoke",
    auditEnabled: false,
  });
  const priorState = await loadRuntimeState(config.runtimeFile);
  upsertSession(priorState, "sess-trust-5", {
    intentTokenRaw: JSON.stringify({ tokenId: "tok_no_revoke" }),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  await saveRuntimeState(config.runtimeFile, priorState);

  const calls = [];
  const intentMod = await import("../scripts/lib/intent.mjs");
  const client = intentMod.getSdkClient(config);
  const originalRevoke = client.revoke;
  client.revoke = async () => {
    calls.push({});
    return { trustId: "should-not-fire" };
  };

  try {
    await handleSessionEnd({ hook_event_name: "SessionEnd", session_id: "sess-trust-5" }, config);
  } finally {
    if (originalRevoke) client.revoke = originalRevoke;
    else delete client.revoke;
  }

  assert.equal(calls.length, 0, "flag off → revoke must not fire");
});

test("Phase 4 A2: Stop hook proactively refreshes a near-expiry token", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-a2-"));
  // Setting useSdkIntent: true with a stub injected into the SDK cache so we
  // can verify requestIntent fires from inside handleStop. apiKey must start
  // with ak_test_ to pass the SDK's prefix validator.
  const config = buildConfig(tmp, {
    intentEndpoint: "",
    useSdkIntent: true,
    apiKey: "ak_test_a2",
    userId: "test-user-a2",
    refreshThresholdSeconds: 30,
    validitySeconds: 600,
  });

  // Seed a session with a plan + a token that's ALMOST expired (< 4×30 = 120s).
  const expiresAt = Math.floor(Date.now() / 1000) + 60; // 60s left
  const priorState = await loadRuntimeState(config.runtimeFile);
  upsertSession(priorState, "sess-a2-1", {
    intentTokenRaw: JSON.stringify({ tokenId: "tok_old", plan: { steps: [] } }),
    plan: { goal: "g", steps: [{ action: "Read" }] },
    expiresAt,
    lastPrompt: "test prompt",
  });
  await saveRuntimeState(config.runtimeFile, priorState);

  const calls = [];
  const intentMod = await import("../scripts/lib/intent.mjs");
  const client = intentMod.getSdkClient(config);
  const originalCapture = client.capturePlan;
  const originalIssue = client.getIntentToken;
  client.capturePlan = (_llm, _goal, plan) => ({ ok: true, plan });
  client.getIntentToken = async (planCapture) => {
    calls.push({ kind: "getIntentToken", plan: planCapture?.plan });
    return {
      tokenId: "tok_refreshed",
      planHash: "h_new",
      signature: "sig",
      issuedAt: Date.now() / 1000,
      expiresAt: Date.now() / 1000 + 600,
      policy: {},
      compositeIdentity: "",
      stepProofs: [],
      totalSteps: 0,
      rawToken: { token: { token_id: "tok_refreshed" } },
    };
  };

  try {
    await handleStop({ hook_event_name: "Stop", session_id: "sess-a2-1" }, config);
  } finally {
    client.capturePlan = originalCapture;
    if (originalIssue) client.getIntentToken = originalIssue;
    else delete client.getIntentToken;
  }

  assert.ok(
    calls.some((c) => c.kind === "getIntentToken"),
    "handleStop should pre-refresh the near-expiry token via getIntentToken"
  );
});

test("Phase 4 A2: Stop hook does NOT refresh when token is fresh", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-a2-fresh-"));
  const config = buildConfig(tmp, {
    useSdkIntent: true,
    apiKey: "ak_test_a2_fresh",
    userId: "test-user-a2-fresh",
    refreshThresholdSeconds: 30,
    validitySeconds: 600,
  });
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 min left
  const priorState = await loadRuntimeState(config.runtimeFile);
  upsertSession(priorState, "sess-a2-2", {
    intentTokenRaw: JSON.stringify({ tokenId: "tok_fresh" }),
    plan: { goal: "g", steps: [{ action: "Read" }] },
    expiresAt,
  });
  await saveRuntimeState(config.runtimeFile, priorState);

  const calls = [];
  const intentMod = await import("../scripts/lib/intent.mjs");
  const client = intentMod.getSdkClient(config);
  const originalIssue = client.getIntentToken;
  client.getIntentToken = async () => {
    calls.push({ kind: "getIntentToken" });
    return {};
  };
  try {
    await handleStop({ hook_event_name: "Stop", session_id: "sess-a2-2" }, config);
  } finally {
    if (originalIssue) client.getIntentToken = originalIssue;
    else delete client.getIntentToken;
  }
  assert.equal(calls.length, 0, "fresh token must not trigger a refresh");
});

test("ArmorClaude's own MCP tools are never drift-blocked (deadlock prevention)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-deadlock-"));
  // Active plan that does NOT include register_intent_plan or any of the
  // plugin's own tools. Without the whitelist, the plugin would deadlock —
  // the agent couldn't even call register_intent_plan to escape.
  // (autoReanchor removed; ignore the field — buildConfig falls back to defaults)
  const config = buildConfig(tmp, {});
  const priorState = await loadRuntimeState(config.runtimeFile);
  upsertSession(priorState, "sess-deadlock-1", {
    intentTokenRaw: JSON.stringify({ tokenId: "tok_x" }),
    plan: { goal: "narrow", steps: [{ action: "Read" }] },
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  await saveRuntimeState(config.runtimeFile, priorState);

  const pluginPrefixed = [
    "mcp__plugin_armorclaude_armorclaude-policy__register_intent_plan",
    "mcp__plugin_armorclaude_armorclaude-policy__policy_read",
    "mcp__plugin_armorclaude_armorclaude-policy__policy_update",
    "mcp__plugin_armorclaude_armorclaude-policy__trust_revoke",
    "mcp__plugin_armorclaude_armorclaude-policy__trust_reanchor",
    "mcp__plugin_armorclaude_armorclaude-policy__trust_delegate",
  ];
  const directPrefixed = [
    "mcp__armorclaude-policy__register_intent_plan",
    "mcp__armorclaude-policy__trust_revoke",
  ];
  const baseTools = [
    "register_intent_plan",
    "policy_read",
    "policy_update",
    "trust_revoke",
    "trust_reanchor",
    "trust_delegate",
  ];

  for (const tool of [...pluginPrefixed, ...directPrefixed, ...baseTools]) {
    const out = await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "sess-deadlock-1",
        tool_name: tool,
        tool_input: { goal: "x", steps: [{ action: "Bash" }] },
      },
      config
    );
    // Allow path returns null (no deny output). A deny would set
    // hookSpecificOutput.permissionDecision = "deny".
    assert.equal(out, null, `${tool} should pass the whitelist (got: ${JSON.stringify(out)})`);
  }
});
