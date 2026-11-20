import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";

const decisionOf = (output) => output?.hookSpecificOutput?.permissionDecision;
const reasonOf = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? "";

async function session(t, env = {}, routes = {}) {
  const backend = await startBackend(routes);
  return { ...(await startHookSession(t, backend, env)), backend };
}

const monitorRoutes = {
  "GET /policies/profiles/active": () => [
    200,
    { version: 1, policy: null, enforcementMode: "shadow" },
  ],
};

test("a handler that throws inside the daemon denies the call in enforce mode", async (t) => {
  const { dataDir, hook } = await session(t);
  await mkdir(path.join(dataDir, "runtime.json"));
  const output = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/x.txt", content: "x" },
  });
  assert.equal(decisionOf(output), "deny", JSON.stringify(output));
  assert.match(reasonOf(output), /ArmorClaude internal error: .*EISDIR/);
});

test("a handler that throws outside PreToolUse reports the error in a shape Claude Code accepts", async (t) => {
  const { dataDir, hook } = await session(t);
  await mkdir(path.join(dataDir, "runtime.json"));
  const output = await hook({ hook_event_name: "SessionStart" });
  assert.equal(output?.hookSpecificOutput, undefined, JSON.stringify(output));
  assert.match(output?.systemMessage ?? "", /ArmorClaude internal error in SessionStart: .*EISDIR/);
});

test("a handler that throws inside the daemon still lets the call run in org Monitor", async (t) => {
  const { dataDir, hook } = await session(t, { ARMORIQ_ORG_MODE: "" }, monitorRoutes);
  await hook({ hook_event_name: "SessionStart" });
  await mkdir(path.join(dataDir, "runtime.json"), { recursive: true }).catch(() => {});
  const output = await hook({
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "/tmp/x.txt", content: "x" },
  });
  assert.notEqual(decisionOf(output), "deny", JSON.stringify(output));
});

test("a corrupt policy.json denies every policy-checked call with a message naming the file", async (t) => {
  const { dataDir, hook } = await session(t);
  const policyFile = path.join(dataDir, "policy.json");
  await writeFile(policyFile, '{"version": 3, "policy": {"schemaVersion"');
  for (const [tool_name, tool_input] of [
    ["Read", { file_path: "/tmp/x.txt" }],
    ["Write", { file_path: "/tmp/x.txt", content: "x" }],
  ]) {
    const output = await hook({ hook_event_name: "PreToolUse", tool_name, tool_input });
    assert.equal(decisionOf(output), "deny", `${tool_name}: ${JSON.stringify(output)}`);
    assert.match(reasonOf(output), /policy file .*policy\.json is not valid JSON/);
    assert.match(reasonOf(output), /blocked until it is fixed or removed/);
  }
});

test("the session banner does not claim ENFORCING when policy.json is corrupt", async (t) => {
  const { dataDir, hook } = await session(t);
  await writeFile(path.join(dataDir, "policy.json"), "{ not json");
  const banner = JSON.stringify(await hook({ hook_event_name: "SessionStart" }));
  assert.doesNotMatch(banner, /ENFORCING/);
  assert.match(banner, /policy file .*policy\.json is not valid JSON/);
});

test("a corrupt policy.json in org Monitor lets the call run and records the would-be block", async (t) => {
  const { dataDir, hook, backend } = await session(t, { ARMORIQ_ORG_MODE: "" }, monitorRoutes);
  await hook({ hook_event_name: "SessionStart" });
  await writeFile(path.join(dataDir, "policy.json"), "{ not json");
  const call = { tool_name: "Read", tool_input: { file_path: "/tmp/x" }, tool_use_id: "use-read" };
  const output = await hook({ hook_event_name: "PreToolUse", ...call });
  assert.notEqual(decisionOf(output), "deny", JSON.stringify(output));
  await hook({ hook_event_name: "PostToolUse", ...call, tool_response: { ok: true } });
  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.auditRows.length === 1, 15_000, "the audit row");
  assert.deepEqual(
    backend.auditRows.map((r) => [r.tool, r.status, r.would_be, r.would_be_code]),
    [["Read", "success", "block", "policy_file_invalid"]]
  );
});
