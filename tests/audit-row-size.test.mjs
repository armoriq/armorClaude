import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";
import { captureSession } from "./helpers/audit-capture.mjs";
import { emitAudit } from "../scripts/lib/audit-capture.mjs";
import { AUDIT_SIZE_LIMITS, createAuditWal, loginTag } from "../scripts/lib/audit-wal.mjs";

const WAL_LINE_CAP = AUDIT_SIZE_LIMITS.maxRowBytes;
const PLAN_ID = randomUUID();
const PLAN = {
  goal: "inspect the repo",
  steps: [
    { action: "Read", mcp: "claude-code" },
    { action: "Bash", mcp: "claude-code" },
    { action: "Write", mcp: "claude-code" },
  ],
};

function sdkIntentToken() {
  const jwtToken = `eyJhbGciOiJFUzI1NiJ9.${"a".repeat(24_000)}.sig`;
  return {
    tokenId: "intent-ref",
    planHash: "plan-hash",
    planId: PLAN_ID,
    signature: "sig",
    issuedAt: 1,
    expiresAt: 4_102_444_800,
    policy: {},
    compositeIdentity: "",
    stepProofs: [],
    totalSteps: PLAN.steps.length,
    rawToken: { plan: PLAN, plan_id: PLAN_ID, token: {}, plan_hash: "plan-hash" },
    jwtToken,
  };
}

async function startSession(t) {
  const backend = await startBackend();
  const session = await startHookSession(t, backend);
  await writeFile(
    path.join(session.dataDir, "runtime.json"),
    JSON.stringify({
      sessions: {
        [session.sessionId]: { intentTokenRaw: JSON.stringify(sdkIntentToken()), plan: PLAN },
      },
    })
  );
  return { ...session, backend };
}

test("PostToolUse rows link the plan by id instead of carrying the intent token, so every step ships (#295)", async (t) => {
  const { backend, sessionId, hook } = await startSession(t);
  const token = sdkIntentToken();
  assert.ok(JSON.stringify(token).length > 24_000);

  for (const [tool_name, tool_input] of [
    ["Read", { file_path: "package.json" }],
    ["Bash", { command: "ls" }],
    ["Write", { file_path: "notes.txt", content: "hi" }],
  ]) {
    await hook({
      hook_event_name: "PostToolUse",
      tool_name,
      tool_input,
      tool_response: { ok: true },
    });
  }

  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.auditRows.length === 3, 15_000, "three rows");
  assert.deepEqual(
    backend.auditRows.map((r) => [r.tool, r.step_index]),
    [
      ["Read", 0],
      ["Bash", 1],
      ["Write", 2],
    ]
  );
  for (const row of backend.auditRows) {
    assert.equal(row.plan_id, PLAN_ID);
    assert.equal(row.token, undefined);
    assert.equal(row.session_id, sessionId);
    assert.equal(row.user_id, "user-login");
    assert.equal(row.status, "success");
  }
});

test("capture over the shared row cap replaces input before output without previews (#295)", async (t) => {
  const { config } = await captureSession(t);
  const big = "x".repeat(WAL_LINE_CAP);
  const common = { plan_id: PLAN_ID, status: "success", executed_at: new Date().toISOString() };
  await emitAudit({
    config,
    dto: {
      ...common,
      client_row_id: randomUUID(),
      tool: "Bash",
      action: "Bash",
      input: { command: "cat big.log" },
      output: { stdout: big, stderr: big },
    },
  });
  await emitAudit({
    config,
    dto: {
      ...common,
      client_row_id: randomUUID(),
      tool: "Write",
      action: "Write",
      input: { file_path: "a.txt", content: big },
      output: { filePath: "a.txt", content: "keep" },
    },
  });
  const wal = createAuditWal({
    dataDir: config.dataDir,
    login: loginTag(config.backendEndpoint, config.apiKey),
    binding: {
      backend: config.backendEndpoint,
      keyId: loginTag(config.backendEndpoint, config.apiKey),
    },
  });
  const shipped = [];
  await wal.drain(
    async ({ rows }) => {
      shipped.push(...rows);
      return { status: 200, body: { failures: [] } };
    },
    {
      resolveLogin: () => ({
        backend: config.backendEndpoint,
        keyId: loginTag(config.backendEndpoint, config.apiKey),
      }),
    }
  );
  assert.equal(shipped.length, 2);
  const [bash, write] = shipped;
  for (const row of shipped) {
    assert.equal(row.plan_id, PLAN_ID);
    assert.ok(Buffer.byteLength(JSON.stringify(row)) <= WAL_LINE_CAP, row.tool);
  }
  assert.deepEqual(bash.input, { truncated: true });
  assert.deepEqual(bash.output, { truncated: true });
  assert.deepEqual(write.input, { truncated: true });
  assert.deepEqual(write.output, { filePath: "a.txt", content: "keep" });
});

test("capture that cannot fit the shared cap keeps a counted dead letter and allows healthy rows (#295)", async (t) => {
  const { config, rows } = await captureSession(t);
  const dto = {
    client_row_id: randomUUID(),
    tool: "Bash",
    action: "Bash",
    input: { command: "make" },
    status: "failed",
    error_message: "e".repeat(WAL_LINE_CAP + 1),
    executed_at: new Date().toISOString(),
  };
  await emitAudit({ config, dto });
  await emitAudit({
    config,
    dto: {
      client_row_id: randomUUID(),
      tool: "Read",
      action: "Read",
      input: { file_path: "package.json" },
    },
  });
  assert.deepEqual(
    (await rows()).map(({ tool }) => tool),
    ["Read"]
  );
  const wal = createAuditWal({
    dataDir: config.dataDir,
    login: loginTag(config.backendEndpoint, config.apiKey),
  });
  const [dead] = await wal.readDeadLetters();
  assert.deepEqual(dead.row, { ...dto, capability: "shell" });
  assert.equal(dead.reason, "oversize");
  assert.equal(dead.attempts, 0);
  assert.equal((await wal.status()).deadLetters, 1);
});
