import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";

const WAL_LINE_CAP = 4000;
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

  await waitFor(() => backend.auditRows.length === 3, 15_000, "three audit rows at the backend");
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

test("a row over the WAL cap ships with its larger field cut down and marked with the original size (#295)", async (t) => {
  const { backend, hook } = await startSession(t);
  const big = "x".repeat(2000);

  await hook({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "cat big.log" },
    tool_response: { stdout: big, stderr: big },
  });
  await hook({
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: "a.txt", content: big, extra: big },
    tool_response: { filePath: "a.txt", content: big },
  });

  await waitFor(() => backend.auditRows.length === 2, 15_000, "two audit rows at the backend");
  const [bash, write] = backend.auditRows;
  for (const row of backend.auditRows) {
    assert.equal(row.plan_id, PLAN_ID);
    assert.ok(Buffer.byteLength(JSON.stringify(row)) <= WAL_LINE_CAP, row.tool);
  }
  assert.deepEqual(bash.input, { command: "cat big.log" });
  assert.equal(bash.output.truncated, true);
  assert.ok(bash.output.originalBytes > 4000);
  assert.ok(bash.output.preview.startsWith('{"stdout":"xxx'));
  assert.equal(write.input.truncated, true);
  assert.ok(write.input.originalBytes > 4000);
  assert.deepEqual(write.output, { filePath: "a.txt", content: big });
});

test("a row that cannot fit the WAL cap is logged to daemon.log instead of vanishing (#295)", async (t) => {
  const { backend, dataDir, hook } = await startSession(t);

  await hook({
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "make" },
    error: "e".repeat(10_000),
  });
  await hook({
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: "package.json" },
    tool_response: { ok: true },
  });

  await waitFor(() => backend.auditRows.length === 1, 15_000, "the Read row at the backend");
  assert.equal(backend.auditRows[0].tool, "Read");
  const log = readFileSync(path.join(dataDir, "daemon.log"), "utf8");
  assert.match(log, /audit row rejected: Bash row is \d+ bytes after truncation, cap is 4000/);
});
