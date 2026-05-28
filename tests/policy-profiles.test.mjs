import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listProfiles, loadProfile, saveProfile, deleteProfile, seedBuiltinProfiles } from "../scripts/lib/policy-profiles.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";
import { savePolicyState } from "../scripts/lib/policy.mjs";

function buildConfig(tmpDir) {
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
      maxItems: 50
    }
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

// ---------------------------------------------------------------------------
// Low-level profile CRUD
// ---------------------------------------------------------------------------

test("seedBuiltinProfiles creates 4 template profiles", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await seedBuiltinProfiles(config);
  const files = await readdir(path.join(tmp, "profiles"));
  const jsonFiles = files.filter(f => f.endsWith(".json"));
  assert.equal(jsonFiles.length, 4);
  assert.ok(jsonFiles.includes("balanced.json"));
  assert.ok(jsonFiles.includes("lockdown.json"));
  assert.ok(jsonFiles.includes("all-allow.json"));
  assert.ok(jsonFiles.includes("strict-read-only.json"));
});

test("seedBuiltinProfiles does not overwrite existing profiles", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await saveProfile(config, "balanced", "custom description", [{ id: "x", action: "deny", tool: "Bash" }]);
  await seedBuiltinProfiles(config);
  const profile = await loadProfile(config, "balanced");
  assert.equal(profile.profile.description, "custom description");
  assert.equal(profile.policy.rules.length, 1);
});

test("listProfiles returns all profiles including builtins", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  const profiles = await listProfiles(config);
  assert.equal(profiles.length, 4);
  const names = profiles.map(p => p.profile.name).sort();
  assert.deepEqual(names, ["all-allow", "balanced", "lockdown", "strict-read-only"]);
});

test("saveProfile creates a new user profile", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  const rules = [{ id: "p1", action: "deny", tool: "Bash" }];
  const saved = await saveProfile(config, "my-custom", "My custom setup", rules);
  assert.equal(saved.profile.name, "my-custom");
  assert.equal(saved.profile.createdBy, "user");
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.policy.rules, rules);
});

test("saveProfile increments version on overwrite", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await saveProfile(config, "test-prof", "v1", []);
  const v2 = await saveProfile(config, "test-prof", "v2", [{ id: "p1", action: "allow", tool: "*" }]);
  assert.equal(v2.version, 2);
});

test("loadProfile returns null for non-existent profile", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await seedBuiltinProfiles(config);
  const result = await loadProfile(config, "nonexistent");
  assert.equal(result, null);
});

test("deleteProfile removes a profile and returns true", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await saveProfile(config, "to-delete", "will be deleted", []);
  const deleted = await deleteProfile(config, "to-delete");
  assert.ok(deleted);
  const loaded = await loadProfile(config, "to-delete");
  assert.equal(loaded, null);
});

test("deleteProfile returns false for non-existent profile", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  const deleted = await deleteProfile(config, "nonexistent");
  assert.equal(deleted, false);
});

// ---------------------------------------------------------------------------
// /armor-policy profile commands via command handler
// ---------------------------------------------------------------------------

test("/armor-policy profile list shows all profiles", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy profile list", config);
  assert.ok(out.includes("Saved profiles"));
  assert.ok(out.includes("balanced"));
  assert.ok(out.includes("lockdown"));
  assert.ok(out.includes("all-allow"));
  assert.ok(out.includes("strict-read-only"));
});

test("/armor-policy profile save saves current policy", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config, [
    { id: "p1", action: "allow", tool: "Read" },
    { id: "p2", action: "deny", tool: "Bash" }
  ]);
  const out = await handleArmorPolicyCommand("/armor-policy profile save my-setup", config);
  assert.ok(out.includes("my-setup"));
  assert.ok(out.includes("saved"));
  assert.ok(out.includes("2 rules"));

  const profile = await loadProfile(config, "my-setup");
  assert.equal(profile.policy.rules.length, 2);
});

test("/armor-policy profile save rejects empty policy", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);
  const out = await handleArmorPolicyCommand("/armor-policy profile save empty", config);
  assert.ok(out.includes("Cannot save empty"));
});

test("/armor-policy profile switch stages profile rules for confirmation", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const switchOut = await handleArmorPolicyCommand("/armor-policy profile switch balanced", config);
  assert.ok(switchOut.includes("Proposed"));
  assert.ok(switchOut.includes("balanced"));
  assert.ok(switchOut.includes("confirm"));
  assert.ok(switchOut.includes("hold-bash"));

  const confirmOut = await handleArmorPolicyCommand("/armor-policy confirm", config);
  assert.ok(confirmOut.includes("Policy updated"));

  const listOut = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(listOut.includes("allow-read"));
  assert.ok(listOut.includes("hold-bash"));
});

test("/armor-policy profile switch rejects unknown profile", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy profile switch nonexistent", config);
  assert.ok(out.includes("Profile not found"));
  assert.ok(out.includes("Available:"));
});

test("/armor-policy profile delete removes a profile", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await saveProfile(config, "temp-prof", "temporary", [{ id: "x", action: "allow", tool: "*" }]);
  const out = await handleArmorPolicyCommand("/armor-policy profile delete temp-prof", config);
  assert.ok(out.includes("deleted"));
  const loaded = await loadProfile(config, "temp-prof");
  assert.equal(loaded, null);
});

test("/armor-policy profile delete rejects unknown profile", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy profile delete nonexistent", config);
  assert.ok(out.includes("Profile not found"));
});

test("/armor-policy profile push without apiKey returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy profile push my-setup", config);
  assert.ok(out.includes("API key"));
});

test("/armor-policy profile pull without apiKey returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy profile pull", config);
  assert.ok(out.includes("API key"));
});

// ---------------------------------------------------------------------------
// End-to-end: save current policy, switch to template, switch back
// ---------------------------------------------------------------------------

test("round-trip: save custom → switch to template → switch back to custom", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "profiles-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config, [
    { id: "p1", action: "allow", tool: "Read" },
    { id: "p2", action: "deny", tool: "Bash" }
  ]);

  await handleArmorPolicyCommand("/armor-policy profile save my-custom", config);

  await handleArmorPolicyCommand("/armor-policy profile switch lockdown", config);
  await handleArmorPolicyCommand("/armor-policy confirm", config);
  let listOut = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(listOut.includes("hold-all"));
  assert.ok(!listOut.includes("p1"));

  await handleArmorPolicyCommand("/armor-policy profile switch my-custom", config);
  await handleArmorPolicyCommand("/armor-policy confirm", config);
  listOut = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(listOut.includes("p1"));
  assert.ok(listOut.includes("p2"));
  assert.ok(!listOut.includes("hold-all"));
});
