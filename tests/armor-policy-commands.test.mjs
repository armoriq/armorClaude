import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isArmorPolicyCommand, handleArmorPolicyCommand, parseNaturalRules } from "../scripts/lib/armor-policy-commands.mjs";
import { handleUserPromptExpansion, handleUserPromptSubmit } from "../scripts/lib/engine.mjs";
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
// isArmorPolicyCommand detection
// ---------------------------------------------------------------------------

test("isArmorPolicyCommand recognises valid commands", () => {
  assert.ok(isArmorPolicyCommand("/armor-policy"));
  assert.ok(isArmorPolicyCommand("/armor-policy list"));
  assert.ok(isArmorPolicyCommand("/armor-policy add allow Bash"));
  assert.ok(isArmorPolicyCommand("  /armor-policy help  "));
  assert.ok(isArmorPolicyCommand("/ARMOR-POLICY list"));
  assert.ok(isArmorPolicyCommand("/armor"));
  assert.ok(isArmorPolicyCommand("/armor policy list"));
  assert.ok(isArmorPolicyCommand("/armor profile save dev-safe"));
  assert.ok(isArmorPolicyCommand("/armor mcp approve github"));
  assert.ok(isArmorPolicyCommand("/armorclaude:armor-policy list"));
});

test("isArmorPolicyCommand rejects non-commands", () => {
  assert.ok(!isArmorPolicyCommand("armor-policy list"));
  assert.ok(!isArmorPolicyCommand("please run /armor-policy list"));
  assert.ok(!isArmorPolicyCommand(""));
  assert.ok(!isArmorPolicyCommand(null));
  assert.ok(!isArmorPolicyCommand(42));
});

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

test("/armor-policy help returns usage text", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy", config);
  assert.ok(out.includes("ArmorClaude Policy Commands"));
  assert.ok(out.includes("/armor policy list"));
  assert.ok(out.includes("Legacy alias"));
});

test("/armor help returns primary UX text", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor", config);
  assert.ok(out.includes("/armor policy add"));
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

test("/armor-policy list shows empty policy", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);
  const out = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(out.includes("no rules configured"));
});

test("/armor-policy list shows existing rules", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config, [{ id: "policy1", action: "deny", tool: "Bash" }]);
  const out = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(out.includes("policy1"));
  assert.ok(out.includes("deny"));
  assert.ok(out.includes("Bash"));
});

// ---------------------------------------------------------------------------
// add + confirm
// ---------------------------------------------------------------------------

test("/armor-policy add stages a rule then confirm applies it", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const addOut = await handleArmorPolicyCommand("/armor-policy add deny Bash", config);
  assert.ok(addOut.includes("Proposed"));
  assert.ok(addOut.includes("deny"));
  assert.ok(addOut.includes("Bash"));
  assert.ok(addOut.includes("confirm"));
  assert.ok(addOut.includes("proposalId"));

  const confirmOut = await handleArmorPolicyCommand("/armor-policy confirm", config);
  assert.ok(confirmOut.includes("Policy updated"));
  assert.ok(confirmOut.includes("v2"));

  const listOut = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(listOut.includes("policy1"));
  assert.ok(listOut.includes("deny"));
  assert.ok(listOut.includes("Bash"));
});

test("/armor policy add parses natural-language multi-rule changes", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const out = await handleArmorPolicyCommand(
    "/armor policy add allow Read and Grep, deny Write, hold Bash",
    config
  );
  assert.ok(out.includes("proposalId"));
  assert.ok(out.includes("allow Read"));
  assert.ok(out.includes("allow Grep"));
  assert.ok(out.includes("deny Write"));
  assert.ok(out.includes("require_approval Bash"));

  const pending = JSON.parse(await readFile(path.join(tmp, "policy-pending.json"), "utf8"));
  assert.match(pending.proposalId, /^pol_[a-f0-9]{8}$/);
  assert.equal(pending.baseVersion, 1);
  assert.equal(pending.proposedRules.length, 4);
  assert.equal(pending.proposedPolicy.schemaVersion, "armor.policy.v1");
  assert.equal(pending.source.type, "deterministic");
  assert.ok(Array.isArray(pending.patch));
  assert.equal(typeof pending.proposalHash, "string");

  const confirmOut = await handleArmorPolicyCommand(`/armor policy confirm ${pending.proposalId}`, config);
  assert.ok(confirmOut.includes("Policy updated"));
  const listOut = await handleArmorPolicyCommand("/armor policy list", config);
  assert.ok(listOut.includes("policy4"));
});

test("/armor policy add complex natural language returns draft-only", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const out = await handleArmorPolicyCommand(
    "/armor policy add \"only allow intern-safe bash file checks, curl, ls, port checks, deny psql and gcloud, save as intern-policy\"",
    config
  );
  assert.ok(out.includes("Drafted from natural language. Not staged."));
  assert.ok(out.includes("Ambiguities:"));
  assert.ok(out.includes("intern-policy"));
  await assert.rejects(readFile(path.join(tmp, "policy-pending.json"), "utf8"));
  const drafts = JSON.parse(await readFile(path.join(tmp, "policy-drafts.json"), "utf8"));
  assert.equal(Object.keys(drafts.drafts).length, 1);
});

test("/armor policy add broad bash except denied programs drafts matching IR", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const out = await handleArmorPolicyCommand(
    "/armor policy add \"name the policy intern-policy and allow read write file tools locally using bash, user can use other things using bash but not psql and gcloud\"",
    config
  );
  assert.ok(out.includes("Drafted from natural language. Not staged."));
  assert.ok(out.includes("intern-policy"));
  const drafts = JSON.parse(await readFile(path.join(tmp, "policy-drafts.json"), "utf8"));
  const draft = Object.values(drafts.drafts)[0];
  assert.equal(draft.policy.metadata.name, "intern-policy");
  assert.deepEqual(draft.policy.statements[0].action.in, ["Read", "Grep", "Glob", "Write", "Edit", "MultiEdit"]);
  const bashAllow = draft.policy.statements.find((statement) => statement.id === "allow-bash-except-denied-programs");
  assert.ok(bashAllow);
  assert.deepEqual(bashAllow.conditions, [
    { field: "bash.program", op: "not_in", value: ["psql", "gcloud"] }
  ]);
});

test("/armor policy add allows all bash phrasing", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const out = await handleArmorPolicyCommand(
    "/armor policy add \"bash tool is allowed for all and for any command\"",
    config
  );
  const draftId = out.match(/draft_[a-f0-9]{8}/)?.[0];
  const drafts = JSON.parse(await readFile(path.join(tmp, "policy-drafts.json"), "utf8"));
  const draft = drafts.drafts[draftId];
  const bashAllow = draft.policy.statements.find((statement) => statement.id === "allow-all-bash");
  assert.ok(bashAllow);
  assert.deepEqual(bashAllow.conditions, []);
  assert.ok(out.includes("All Bash commands are allowed"));
});

test("/armor policy add can omit explicit forbid when prompt asks to remove it", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const out = await handleArmorPolicyCommand(
    "/armor policy add \"allow read write file tools locally using bash, user can use other things using bash but not psql and gcloud and remove the forbid cloud db admin policy\"",
    config
  );
  const draftId = out.match(/draft_[a-f0-9]{8}/)?.[0];
  const drafts = JSON.parse(await readFile(path.join(tmp, "policy-drafts.json"), "utf8"));
  const draft = drafts.drafts[draftId];
  assert.equal(draft.policy.statements.some((statement) => statement.id === "forbid-cloud-db-admin"), false);
  assert.ok(draft.policy.statements.some((statement) => statement.id === "allow-bash-except-denied-programs"));
});

test("/armor policy revise removes a draft statement deterministically", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const out = await handleArmorPolicyCommand(
    "/armor policy add \"name the policy intern-policy and allow read write file tools locally using bash, user can use other things using bash but not psql and gcloud\"",
    config
  );
  const draftId = out.match(/draft_[a-f0-9]{8}/)?.[0];
  assert.ok(draftId);

  const revisedOut = await handleArmorPolicyCommand(
    `/armor policy revise ${draftId} "remove forbid-cloud-db-admin"`,
    config
  );
  assert.ok(revisedOut.includes("Draft revised. Not staged."));
  assert.ok(revisedOut.includes("Removed statements: forbid-cloud-db-admin"));
  const newDraftId = revisedOut.match(/New draft: (draft_[a-f0-9]{8})/)?.[1];
  assert.ok(newDraftId);

  const drafts = JSON.parse(await readFile(path.join(tmp, "policy-drafts.json"), "utf8"));
  const draft = drafts.drafts[newDraftId];
  assert.ok(draft);
  assert.equal(draft.policy.statements.some((statement) => statement.id === "forbid-cloud-db-admin"), false);
});

test("/armor policy revise returns draft not found for mistyped draft id", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand(
    `/armor policy revise draft_10a47c5 "remove forbid-cloud-db-admin"`,
    config
  );
  assert.equal(out, "Draft not found: draft_10a47c5");
});

test("/armor policy revise can add Explore to a draft", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const out = await handleArmorPolicyCommand(
    "/armor policy add \"only allow read files and ls, deny psql\"",
    config
  );
  const draftId = out.match(/draft_[a-f0-9]{8}/)?.[0];
  assert.ok(draftId);

  const revisedOut = await handleArmorPolicyCommand(
    `/armor policy revise ${draftId} "allow Explore"`,
    config
  );
  const newDraftId = revisedOut.match(/New draft: (draft_[a-f0-9]{8})/)?.[1];
  const drafts = JSON.parse(await readFile(path.join(tmp, "policy-drafts.json"), "utf8"));
  const draft = drafts.drafts[newDraftId];
  assert.ok(draft.policy.statements.some((statement) => statement.id === "allow-explore"));
});

test("/armor policy draft edit replaces a draft with validated pasted JSON", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const out = await handleArmorPolicyCommand(
    "/armor policy add \"only allow read files and deny psql\"",
    config
  );
  const draftId = out.match(/draft_[a-f0-9]{8}/)?.[0];
  assert.ok(draftId);
  const replacement = {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "manual", description: "manual edit" },
    defaults: { decision: "allow", conflictResolution: "deny_overrides" },
    statements: [
      {
        id: "deny-psql",
        effect: "forbid",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Bash" },
        resource: { type: "workspace", scope: "current" },
        conditions: [{ field: "bash.program", op: "in", value: ["psql"] }]
      }
    ]
  };
  const editOut = await handleArmorPolicyCommand(
    `/armor policy draft edit ${draftId} ${JSON.stringify(replacement)}`,
    config
  );
  assert.ok(editOut.includes("Manual JSON replacement validated"));
  const newDraftId = editOut.match(/New draft: (draft_[a-f0-9]{8})/)?.[1];
  const drafts = JSON.parse(await readFile(path.join(tmp, "policy-drafts.json"), "utf8"));
  assert.equal(drafts.drafts[newDraftId].policy.defaults.decision, "allow");
});

test("/armor policy draft validate accepts valid IR and stage creates proposal", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);
  const ir = {
    schemaVersion: "armor.policy.v1",
    kind: "PolicyProfile",
    metadata: { name: "intern-policy", description: "" },
    defaults: { decision: "deny", conflictResolution: "deny_overrides" },
    statements: [
      {
        id: "allow-read",
        effect: "permit",
        principal: { type: "agent", id: "claude-code" },
        action: { type: "tool", eq: "Read" },
        resource: { type: "workspace", scope: "current" },
        conditions: []
      }
    ]
  };
  const draftOut = await handleArmorPolicyCommand(`/armor policy draft validate ${JSON.stringify(ir)}`, config);
  assert.ok(draftOut.includes("Drafted from natural language. Not staged."));
  const draftId = draftOut.match(/draft_[a-f0-9]{8}/)?.[0];
  assert.ok(draftId);
  const stageOut = await handleArmorPolicyCommand(`/armor policy stage ${draftId}`, config);
  assert.ok(stageOut.includes("Staged validated policy draft"));
  assert.ok(stageOut.includes("proposalId"));
  const pending = JSON.parse(await readFile(path.join(tmp, "policy-pending.json"), "utf8"));
  assert.equal(pending.source.type, "llm_draft_stage");
});

test("/armor policy draft validate rejects unsafe malformed IR", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand(
    "/armor policy draft validate {\"schemaVersion\":\"armor.policy.v1\",\"kind\":\"PolicyProfile\",\"metadata\":{},\"defaults\":{\"decision\":\"deny\",\"conflictResolution\":\"deny_overrides\"},\"statements\":[{\"id\":\"bad\",\"effect\":\"permit\",\"principal\":{\"type\":\"agent\",\"id\":\"claude-code\"},\"action\":{\"type\":\"tool\",\"eq\":\"TotallyFake\"},\"resource\":{\"type\":\"workspace\",\"scope\":\"current\"},\"conditions\":[],\"extra\":true}]}"
  , config);
  assert.ok(out.includes("Draft validation failed"));
  assert.ok(out.includes("Unknown tool"));
});

test("parseNaturalRules supports deterministic aliases and rejects vague input", () => {
  assert.deepEqual(parseNaturalRules("add block shell and web fetch"), [
    { action: "deny", tool: "Bash" },
    { action: "deny", tool: "WebFetch" }
  ]);
  assert.deepEqual(parseNaturalRules("add please make it safe"), []);
});

// ---------------------------------------------------------------------------
// add + cancel
// ---------------------------------------------------------------------------

test("/armor-policy add then cancel discards staged change", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  await handleArmorPolicyCommand("/armor-policy add allow Write", config);
  const cancelOut = await handleArmorPolicyCommand("/armor-policy cancel", config);
  assert.ok(cancelOut.includes("discarded"));

  const listOut = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(listOut.includes("no rules configured"));
});

test("/armor policy cancel requires matching proposal id when supplied", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  await handleArmorPolicyCommand("/armor policy add deny Bash", config);
  const wrongOut = await handleArmorPolicyCommand("/armor policy cancel pol_wrong", config);
  assert.ok(wrongOut.includes("Proposal not found"));
  const pending = JSON.parse(await readFile(path.join(tmp, "policy-pending.json"), "utf8"));
  const cancelOut = await handleArmorPolicyCommand(`/armor policy cancel ${pending.proposalId}`, config);
  assert.ok(cancelOut.includes("discarded"));
});

test("/armor policy confirm rejects stale base versions and proposal tampering", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  await handleArmorPolicyCommand("/armor policy add deny Bash", config);
  await savePolicyState(config.policyFile, {
    version: 2,
    updatedAt: new Date().toISOString(),
    updatedBy: "external",
    policy: { rules: [{ id: "external", action: "allow", tool: "Read" }] },
    history: []
  });
  let out = await handleArmorPolicyCommand("/armor policy confirm", config);
  assert.ok(out.includes("Policy changed since proposal"));

  await seedPolicy(config);
  await handleArmorPolicyCommand("/armor policy add deny Bash", config);
  const pendingPath = path.join(tmp, "policy-pending.json");
  const pending = JSON.parse(await readFile(pendingPath, "utf8"));
  pending.proposedRules.push({ id: "evil", action: "allow", tool: "*" });
  await writeFile(pendingPath, JSON.stringify(pending), "utf8");
  out = await handleArmorPolicyCommand("/armor policy confirm", config);
  assert.ok(out.includes("hash mismatch"));
});

test("/armor policy confirm can save the applied policy as a profile", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  await handleArmorPolicyCommand("/armor policy add deny Bash", config);
  const pending = JSON.parse(await readFile(path.join(tmp, "policy-pending.json"), "utf8"));
  const out = await handleArmorPolicyCommand(`/armor policy confirm ${pending.proposalId} save dev-safe`, config);
  assert.ok(out.includes("Profile \"dev-safe\" saved"));
  const profilesOut = await handleArmorPolicyCommand("/armor profile list", config);
  assert.ok(profilesOut.includes("dev-safe"));
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

test("/armor-policy remove stages removal then confirm applies it", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config, [
    { id: "policy1", action: "allow", tool: "Read" },
    { id: "policy2", action: "deny", tool: "Bash" }
  ]);

  const removeOut = await handleArmorPolicyCommand("/armor-policy remove policy2", config);
  assert.ok(removeOut.includes("Proposed"));
  assert.ok(removeOut.includes("- policy2"));

  await handleArmorPolicyCommand("/armor-policy confirm", config);
  const listOut = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(listOut.includes("policy1"));
  assert.ok(!listOut.includes("policy2"));
});

test("/armor-policy remove non-existent rule returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);
  const out = await handleArmorPolicyCommand("/armor-policy remove xyz", config);
  assert.ok(out.includes("Rule not found"));
});

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

test("/armor-policy reset stages clearing all rules", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config, [
    { id: "policy1", action: "allow", tool: "Read" },
    { id: "policy2", action: "deny", tool: "Bash" }
  ]);

  const resetOut = await handleArmorPolicyCommand("/armor-policy reset", config);
  assert.ok(resetOut.includes("clear ALL"));

  await handleArmorPolicyCommand("/armor-policy confirm", config);
  const listOut = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(listOut.includes("no rules configured"));
});

// ---------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------

test("/armor-policy template applies a known template", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);

  const tmplOut = await handleArmorPolicyCommand("/armor-policy template balanced", config);
  assert.ok(tmplOut.includes("Balanced"));
  assert.ok(tmplOut.includes("confirm"));

  await handleArmorPolicyCommand("/armor-policy confirm", config);
  const listOut = await handleArmorPolicyCommand("/armor-policy list", config);
  assert.ok(listOut.includes("allow-read"));
  assert.ok(listOut.includes("hold-bash"));
});

test("/armor-policy template rejects unknown template", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy template nonexistent", config);
  assert.ok(out.includes("Unknown template"));
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

test("/armor-policy export dumps JSON", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config, [{ id: "policy1", action: "allow", tool: "*" }]);
  const out = await handleArmorPolicyCommand("/armor-policy export", config);
  const parsed = JSON.parse(out);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.policy.rules.length, 1);
});

// ---------------------------------------------------------------------------
// confirm/cancel with nothing staged
// ---------------------------------------------------------------------------

test("/armor-policy confirm with nothing staged returns message", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy confirm", config);
  assert.ok(out.includes("Nothing staged"));
});

test("/armor-policy cancel with nothing staged returns message", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy cancel", config);
  assert.ok(out.includes("Nothing staged"));
});

// ---------------------------------------------------------------------------
// hold alias → require_approval
// ---------------------------------------------------------------------------

test("/armor-policy add hold maps to require_approval", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);
  const out = await handleArmorPolicyCommand("/armor-policy add hold Bash", config);
  assert.ok(out.includes("require_approval"));
});

// ---------------------------------------------------------------------------
// Engine integration: /armor-policy blocks prompt and returns response
// ---------------------------------------------------------------------------

test("handleUserPromptSubmit blocks and handles /armor-policy list", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);
  const output = await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-policy-1",
      prompt: "/armor-policy list"
    },
    config
  );
  assert.equal(output?.decision, "block");
  assert.ok(output?.reason?.includes("no rules configured"));
});

test("handleUserPromptSubmit blocks and handles /armor policy aliases", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  await seedPolicy(config);
  for (const prompt of ["/armor policy list", "/armorclaude:armor-policy list"]) {
    const output = await handleUserPromptSubmit(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: `session-${prompt}`,
        prompt
      },
      config
    );
    assert.equal(output?.decision, "block");
    assert.ok(output?.reason?.includes("no rules configured"));
  }
});

test("handleUserPromptExpansion blocks armor policy skill expansion", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const output = await handleUserPromptExpansion(
    {
      hook_event_name: "UserPromptExpansion",
      prompt: "/armorclaude:armor-policy"
    },
    config
  );
  assert.equal(output?.decision, "block");
  assert.ok(output?.reason?.includes("/armor policy"));
});

test("handleUserPromptExpansion executes /armor slash command through secure hook", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const output = await handleUserPromptExpansion(
    {
      hook_event_name: "UserPromptExpansion",
      expansion_type: "slash_command",
      command_name: "armor",
      command_args: "policy list",
      command_source: "plugin",
      prompt: "/armor policy list"
    },
    config
  );
  assert.equal(output?.decision, "block");
  assert.match(output?.reason || "", /policy state|Policy v/i);
});

test("handleUserPromptExpansion executes legacy /armor-policy command through secure hook", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const output = await handleUserPromptExpansion(
    {
      hook_event_name: "UserPromptExpansion",
      expansion_type: "slash_command",
      command_name: "armor-policy",
      command_args: "list",
      command_source: "plugin",
      prompt: "/armor-policy list"
    },
    config
  );
  assert.equal(output?.decision, "block");
  assert.match(output?.reason || "", /policy state|Policy v/i);
});

test("handleUserPromptSubmit blocks and handles /armor-policy help", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const output = await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-policy-2",
      prompt: "/armor-policy"
    },
    config
  );
  assert.equal(output?.decision, "block");
  assert.ok(output?.reason?.includes("ArmorClaude Policy Commands"));
});

test("handleUserPromptSubmit does NOT block normal prompts", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const output = await handleUserPromptSubmit(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-policy-3",
      prompt: "summarize this file"
    },
    config
  );
  assert.notEqual(output?.decision, "block");
});

// ---------------------------------------------------------------------------
// Stub commands return not-yet-implemented
// ---------------------------------------------------------------------------

test("/armor-policy mcp list returns server list", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy mcp list", config);
  assert.ok(out.includes("No MCP servers") || out.includes("MCP servers"));
});

test("/armor-policy profile list returns profiles", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy profile list", config);
  assert.ok(out.includes("Saved profiles"));
});

test("/armor-policy settings shows enforcement engine", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy settings", config);
  assert.ok(out.includes("Enforcement engine"));
});

test("/armor-policy sync without apiKey returns error", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armor-policy-test-"));
  const config = buildConfig(tmp);
  const out = await handleArmorPolicyCommand("/armor-policy sync", config);
  assert.ok(out.includes("API key"));
});
