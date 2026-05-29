import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  reanchorViaSdk,
  revokeViaSdk,
  delegateSubtreeViaSdk,
} from "../scripts/lib/iap-service.mjs";
import {
  loadRuntimeState,
  upsertSession,
  appendTrustOp,
  getTrustOps,
  saveRuntimeState,
} from "../scripts/lib/runtime-state.mjs";

// ---------------------------------------------------------------------------
// Mock SDK client — matches the shape of @armoriq/sdk's ArmorIQClient just
// enough for the wrappers under test. Each test injects its own getClient
// closure so calls and failures can be observed.
// ---------------------------------------------------------------------------

function mockClient({ revoke, reanchor, delegateSubtree } = {}) {
  return {
    revoke: revoke || (async () => ({ trustId: "tr_revoke_default" })),
    reanchor:
      reanchor ||
      (async () => ({
        trustId: "tr_reanchor_default",
        delta: { payload: { from_hash: "h1", to_hash: "h2" } },
      })),
    delegateSubtree:
      delegateSubtree ||
      (async () => ({
        trustId: "tr_delegate_default",
        delegationId: "dl_default",
        inclusionProof: [{ position: "L", sibling_hash: "ab" }],
        subtreeRoot: "sr_default",
      })),
  };
}

const baseConfig = { apiKey: "ak_test", useSdkIntent: true };

// ---------------------------------------------------------------------------
// reanchorViaSdk
// ---------------------------------------------------------------------------

test("reanchorViaSdk forwards token + plan + reason to client.reanchor", async () => {
  let captured = null;
  const client = mockClient({
    reanchor: async (token, plan, reason) => {
      captured = { token, plan, reason };
      return { trustId: "tr_42", delta: { payload: { from_hash: "AAA", to_hash: "BBB" } } };
    },
  });
  const result = await reanchorViaSdk({
    getClient: () => client,
    config: baseConfig,
    intentToken: { tokenId: "tok_1" },
    updatedPlan: { goal: "g", steps: [{ action: "x" }] },
    reason: "plan grew",
  });
  assert.equal(result.ok, true);
  assert.equal(result.trustId, "tr_42");
  assert.equal(result.fromHash, "AAA");
  assert.equal(result.toHash, "BBB");
  assert.deepEqual(captured?.plan, { goal: "g", steps: [{ action: "x" }] });
  assert.equal(captured?.reason, "plan grew");
});

test("reanchorViaSdk returns ok=false when SDK throws (does not propagate)", async () => {
  const client = mockClient({
    reanchor: async () => {
      throw new Error("iap unreachable");
    },
  });
  const result = await reanchorViaSdk({
    getClient: () => client,
    config: baseConfig,
    intentToken: { tokenId: "x" },
    updatedPlan: { steps: [] },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /iap unreachable/);
});

test("reanchorViaSdk fails fast when SDK is disabled (no apiKey)", async () => {
  const result = await reanchorViaSdk({
    getClient: () => mockClient(),
    config: { useSdkIntent: true }, // no apiKey
    intentToken: {},
    updatedPlan: { steps: [] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "sdk-disabled");
});

test("reanchorViaSdk validates required args", async () => {
  const a = await reanchorViaSdk({ getClient: () => mockClient(), config: baseConfig });
  assert.equal(a.ok, false);
  const b = await reanchorViaSdk({
    getClient: () => mockClient(),
    config: baseConfig,
    intentToken: {},
  });
  assert.equal(b.ok, false);
});

// ---------------------------------------------------------------------------
// revokeViaSdk
// ---------------------------------------------------------------------------

test("revokeViaSdk forwards full intent token + reason + cascade to client.revoke", async () => {
  let captured = null;
  const client = mockClient({
    revoke: async (token, reason, opts) => {
      captured = { token, reason, opts };
      return { trustId: "tr_revoke_99", cascadedRevocations: ["child_1"] };
    },
  });
  const result = await revokeViaSdk({
    getClient: () => client,
    config: baseConfig,
    intentToken: { tokenId: "parent_token" },
    reason: "stop",
    cascade: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.trustId, "tr_revoke_99");
  assert.deepEqual(result.cascadedRevocations, ["child_1"]);
  assert.equal(captured?.reason, "stop");
  assert.equal(captured?.opts?.cascade, true);
});

test("revokeViaSdk synthesizes minimal token when only tokenId is given", async () => {
  let captured = null;
  const client = mockClient({
    revoke: async (token) => {
      captured = token;
      return { trustId: "tr_via_id" };
    },
  });
  const result = await revokeViaSdk({
    getClient: () => client,
    config: baseConfig,
    tokenId: "tok_only",
    reason: "operator",
  });
  assert.equal(result.ok, true);
  // The synthesized shape carries token_id deep enough for the backend's
  // relaxed RevokeDto to extract it.
  assert.equal(captured?.tokenId, "tok_only");
  assert.equal(captured?.token_id, "tok_only");
});

test("revokeViaSdk swallows SDK errors and reports", async () => {
  const client = mockClient({
    revoke: async () => {
      throw new Error("backend 500");
    },
  });
  const result = await revokeViaSdk({
    getClient: () => client,
    config: baseConfig,
    intentToken: { tokenId: "t" },
    reason: "x",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /backend 500/);
});

// ---------------------------------------------------------------------------
// delegateSubtreeViaSdk
// ---------------------------------------------------------------------------

test("delegateSubtreeViaSdk forwards subtreePath + delegate key", async () => {
  let captured = null;
  const client = mockClient({
    delegateSubtree: async (token, opts) => {
      captured = { token, opts };
      return {
        trustId: "tr_d_1",
        delegationId: "dl_1",
        inclusionProof: [
          { position: "R", sibling_hash: "cd" },
          { position: "L", sibling_hash: "ef" },
        ],
        subtreeRoot: "sr_xyz",
        delegatedToken: { tokenId: "child" },
      };
    },
  });
  const result = await delegateSubtreeViaSdk({
    getClient: () => client,
    config: baseConfig,
    intentToken: { tokenId: "parent" },
    opts: { delegatePublicKey: "bobpk", subtreePath: "/steps/[1]", validitySeconds: 600 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.trustId, "tr_d_1");
  assert.equal(result.delegationId, "dl_1");
  assert.equal(captured?.opts?.subtreePath, "/steps/[1]");
  assert.equal(captured?.opts?.delegatePublicKey, "bobpk");
  assert.equal(Array.isArray(result.inclusionProof) ? result.inclusionProof.length : 0, 2);
});

test("delegateSubtreeViaSdk validates required args", async () => {
  const r = await delegateSubtreeViaSdk({
    getClient: () => mockClient(),
    config: baseConfig,
    intentToken: { tokenId: "p" },
    // no opts
  });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// runtime-state: appendTrustOp + getTrustOps
// ---------------------------------------------------------------------------

test("appendTrustOp persists ordered audit entries on the session", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "armorclaude-trustop-"));
  const runtimeFile = path.join(tmp, "runtime.json");
  const state = await loadRuntimeState(runtimeFile);
  upsertSession(state, "s1", { intentTokenRaw: "raw" });

  appendTrustOp(state, "s1", { operation: "ReAnchor", trustId: "t1", fromHash: "a", toHash: "b" });
  appendTrustOp(state, "s1", { operation: "Revoke", trustId: "t2", reason: "stop", ok: true });
  appendTrustOp(state, "s1", { operation: "Delegate", trustId: "t3", ok: false });

  const ops = getTrustOps(state, "s1");
  assert.equal(ops.length, 3);
  assert.deepEqual(
    ops.map((o) => o.operation),
    ["ReAnchor", "Revoke", "Delegate"]
  );
  assert.equal(ops[0].fromHash, "a");
  assert.equal(ops[2].ok, false);

  await saveRuntimeState(runtimeFile, state);
  const reread = await loadRuntimeState(runtimeFile);
  assert.equal(getTrustOps(reread, "s1").length, 3);
});

test("appendTrustOp tolerates missing session and missing op", () => {
  const state = { sessions: {} };
  appendTrustOp(state, "missing", { operation: "Revoke" }); // should not throw
  appendTrustOp(state, "", { operation: "Revoke" }); // empty session id
  appendTrustOp(state, "x", null); // null op
  assert.equal(getTrustOps(state, "missing").length, 0);
});
