import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { loadPolicyState, savePolicyState } from "../scripts/lib/policy.mjs";
import { canonicalPolicyHash } from "../scripts/lib/policy-ir.mjs";
import { startBackend, startHookSession } from "./helpers/hook-session.mjs";

const statement = (id, effect, tool) => ({
  id,
  effect,
  principal: { type: "agent", id: "claude-code" },
  action: { type: "tool", eq: tool },
  resource: { type: "workspace", scope: "current" },
  conditions: [],
});

const profile = (name, statements) => ({
  schemaVersion: "armor.policy.v1",
  kind: "PolicyProfile",
  metadata: { name, description: "" },
  defaults: { decision: "allow", conflictResolution: "deny_overrides" },
  statements,
});

const OTHER_ORG = profile("acme-guardrails", [statement("deny-write", "forbid", "Write")]);
const LOCAL = profile("my-rules", [statement("no-glob", "forbid", "Glob")]);

const synced = (version, policy) => ({ version, updatedBy: "dashboard-sync", policy });

async function orgWithoutPolicy(t, csrg = () => [200, { token: "csrg-policy-token" }]) {
  const backend = await startBackend({
    "GET /policies/profiles/active": () => [200, { version: 0, policy: null }],
    "POST /intent": csrg,
  });
  return startHookSession(t, backend);
}

const write = { tool_name: "Write", tool_input: { file_path: "/tmp/x", content: "hi" } };
const glob = { tool_name: "Glob", tool_input: { pattern: "*" } };
const reasonOf = (out) => out?.hookSpecificOutput?.permissionDecisionReason ?? "";

test("a policy synced from another org stops applying when the connected org has none", async (t) => {
  const { hook, dataDir } = await orgWithoutPolicy(t);
  const policyFile = path.join(dataDir, "policy.json");
  await savePolicyState(policyFile, {
    ...synced(1, OTHER_ORG),
    history: [synced(1, OTHER_ORG)],
  });
  await writeFile(
    path.join(dataDir, "crypto-policy-state.json"),
    JSON.stringify({ policyDigest: canonicalPolicyHash(OTHER_ORG), token: {} })
  );

  const started = JSON.stringify(await hook({ hook_event_name: "SessionStart" }));
  assert.match(started, /policy from your previous org no longer applies/);
  assert.doesNotMatch(started, /Policy synced from dashboard/);
  assert.equal(await hook({ hook_event_name: "PreToolUse", ...write }), null);

  const state = await loadPolicyState(policyFile);
  assert.deepEqual(
    state.policy.statements.map((s) => s.id),
    ["allow-all"]
  );
  const crypto = JSON.parse(await readFile(path.join(dataDir, "crypto-policy-state.json"), "utf8"));
  assert.equal(crypto.policyDigest, canonicalPolicyHash(state.policy));
});

test("the user's own local rules come back when the synced policy is dropped", async (t) => {
  const { hook, dataDir } = await orgWithoutPolicy(t);
  const policyFile = path.join(dataDir, "policy.json");
  await savePolicyState(policyFile, {
    ...synced(2, OTHER_ORG),
    history: [{ version: 1, updatedBy: "user", policy: LOCAL }, synced(2, OTHER_ORG)],
  });

  await hook({ hook_event_name: "SessionStart" });
  assert.doesNotMatch(
    reasonOf(await hook({ hook_event_name: "PreToolUse", ...write })),
    /deny-write/
  );
  assert.match(reasonOf(await hook({ hook_event_name: "PreToolUse", ...glob })), /no-glob/);
  assert.equal((await loadPolicyState(policyFile)).policy.metadata.name, "my-rules");
});

test("a stale crypto digest is cleared when the new policy cannot be bound", async (t) => {
  const { hook, dataDir } = await orgWithoutPolicy(t, () => [503, { error: "down" }]);
  await savePolicyState(path.join(dataDir, "policy.json"), {
    ...synced(1, OTHER_ORG),
    history: [synced(1, OTHER_ORG)],
  });
  const cryptoFile = path.join(dataDir, "crypto-policy-state.json");
  await writeFile(
    cryptoFile,
    JSON.stringify({ policyDigest: canonicalPolicyHash(OTHER_ORG), token: {} })
  );

  await hook({ hook_event_name: "SessionStart" });
  assert.equal(await hook({ hook_event_name: "PreToolUse", ...write }), null);
  assert.equal(JSON.parse(await readFile(cryptoFile, "utf8")), null);
});

test("a synced policy put back after the Monitor stand-in is still dropped", async (t) => {
  const { hook, dataDir } = await orgWithoutPolicy(t);
  const policyFile = path.join(dataDir, "policy.json");
  const standIn = { ...profile("armoriq-monitor-stand-in", []) };
  await savePolicyState(policyFile, {
    version: 4,
    updatedBy: "monitor-restore",
    policy: OTHER_ORG,
    history: [
      { version: 1, updatedBy: "user", policy: LOCAL },
      synced(2, OTHER_ORG),
      synced(3, standIn),
      { version: 4, updatedBy: "monitor-restore", policy: OTHER_ORG },
    ],
  });

  await hook({ hook_event_name: "SessionStart" });
  assert.doesNotMatch(
    reasonOf(await hook({ hook_event_name: "PreToolUse", ...write })),
    /deny-write/
  );
  assert.equal((await loadPolicyState(policyFile)).policy.metadata.name, "my-rules");
});

test("dropping a synced policy happens once, not on every session", async (t) => {
  const { hook, dataDir } = await orgWithoutPolicy(t);
  const policyFile = path.join(dataDir, "policy.json");
  await savePolicyState(policyFile, { ...synced(1, OTHER_ORG), history: [synced(1, OTHER_ORG)] });

  await hook({ hook_event_name: "SessionStart" });
  await hook({ hook_event_name: "SessionStart" });
  assert.equal((await loadPolicyState(policyFile)).version, 2);
});

test("local rules the user wrote stay when the connected org has no policy", async (t) => {
  const { hook, dataDir } = await orgWithoutPolicy(t);
  const policyFile = path.join(dataDir, "policy.json");
  await savePolicyState(policyFile, {
    version: 1,
    updatedBy: "user",
    policy: LOCAL,
    history: [{ version: 1, updatedBy: "user", policy: LOCAL }],
  });

  await hook({ hook_event_name: "SessionStart" });
  assert.match(reasonOf(await hook({ hook_event_name: "PreToolUse", ...glob })), /no-glob/);
  assert.equal((await loadPolicyState(policyFile)).version, 1);
});
