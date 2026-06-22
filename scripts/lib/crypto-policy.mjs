/**
 * Crypto-Bound Policy Service
 *
 * Embeds policy rules into CSRG tokens with cryptographic (Merkle tree) proofs.
 * Ported from ArmorClaw's CryptoPolicyService (crypto-policy.service.ts).
 *
 * Flow:
 *  1. Policy update -> build policy metadata -> call CSRG /intent
 *  2. CSRG hashes policy into Merkle tree -> signs with Ed25519
 *  3. Tool execution -> verify policy digest matches token
 *
 * State is persisted to disk because hooks are stateless short-lived processes.
 */

import { isPlainObject, postJson, sha256Hex } from "./common.mjs";
import { readJson, writeJson } from "./fs-store.mjs";
import { canonicalPolicyHash, normalizePolicyIr, POLICY_IR_VERSION } from "./policy-ir.mjs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Policy digest computation
// ---------------------------------------------------------------------------

/**
 * Compute a canonical SHA-256 digest of policy rules.
 * Must match ArmorClaw's computePolicyDigest exactly.
 */
export function computePolicyDigest(rules) {
  if (!Array.isArray(rules)) return sha256Hex("policy|[]");
  const canonical = JSON.stringify(
    rules.map((r) => ({
      id: r.id,
      action: r.action,
      tool: r.tool,
      dataClass: r.dataClass,
      params: r.params,
      scope: r.scope,
    })),
    null,
    0
  );
  return sha256Hex(`policy|${canonical}`);
}

export function computeCryptoPolicyDigest(policyState) {
  const policy = policyState?.policy || policyState;
  if (isPlainObject(policy) && policy.schemaVersion === POLICY_IR_VERSION) {
    return canonicalPolicyHash(policy);
  }
  return computePolicyDigest(policy?.rules || []);
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

/**
 * Create a CryptoPolicyService instance.
 * Adapted for stateless hook execution with file-based persistence.
 */
export function createCryptoPolicyService(config) {
  const csrgEndpoint = config.csrgEndpoint || "";
  const timeoutMs = config.timeoutMs || 30000;
  const maxRetries = Math.max(0, Number.isFinite(config.maxRetries) ? config.maxRetries : 0);
  const stateFilePath = path.join(config.dataDir, "crypto-policy-state.json");

  return {
    /**
     * Issue a new CSRG policy token with policy embedded in Merkle tree.
     */
    async issuePolicyToken(policyState, identity, validitySeconds = 3600) {
      const digest = computeCryptoPolicyDigest(policyState);

      const policyMetadata = {
        schema_version: policyState.policy?.schemaVersion,
        statements: policyState.policy?.statements || [],
        version: policyState.version || 0,
        updated_at: policyState.updatedAt || new Date().toISOString(),
        updated_by: policyState.updatedBy,
        policy_digest: digest,
      };

      const plan = buildPolicyPlan(policyState.policy);

      const request = {
        plan,
        policy: {
          global: {
            metadata: policyMetadata,
          },
        },
        identity: {
          user_id: identity.userId || config.userId || "claude-user",
          agent_id: identity.agentId || config.agentId || "claude-code",
          context_id: identity.contextId || config.contextId || "default",
        },
        validity_seconds: validitySeconds,
      };

      const response = await postJsonWithRetry(
        `${csrgEndpoint}/intent`,
        request,
        { "Content-Type": "application/json" },
        timeoutMs,
        maxRetries
      );

      if (!response.ok || !response.data) {
        const msg = response.text || `CSRG /intent failed with status ${response.status}`;
        throw new Error(`Policy token issuance failed: ${msg}`);
      }

      const token = {
        ...response.data,
        policy_digest: digest,
      };

      // Persist to disk
      await writeJson(stateFilePath, {
        token,
        policyDigest: digest,
        issuedAt: Date.now(),
      });

      return token;
    },

    /**
     * Verify that the current policy digest matches the cached token digest.
     * Returns { valid, reason }.
     */
    verifyPolicyDigest(currentDigest, tokenDigest) {
      if (!tokenDigest) {
        return {
          valid: false,
          reason: "No policy token - policy not cryptographically bound",
        };
      }
      if (currentDigest !== tokenDigest) {
        return {
          valid: false,
          reason: `Policy mismatch: current=${currentDigest.slice(0, 16)}... token=${tokenDigest.slice(0, 16)}...`,
        };
      }
      return { valid: true, reason: "Policy digest verified" };
    },

    /**
     * Verify a policy rule is included in the token using CSRG /verify/action.
     */
    async verifyPolicyRule(ruleId, toolName) {
      const cached = await this.loadCachedState();
      if (!cached?.token) {
        return { allowed: false, reason: "No policy token cached" };
      }

      const ruleProof = cached.token.step_proofs?.find(
        (p) => p.path?.includes(ruleId) || p.path?.includes(toolName)
      );

      if (!ruleProof) {
        return { allowed: true, reason: "No specific proof required" };
      }

      const verifyRequest = {
        path: ruleProof.path,
        value: { tool: toolName, rule_id: ruleId },
        proof: ruleProof.proof,
        token: cached.token.token,
      };

      const response = await postJson(
        `${csrgEndpoint}/verify/action`,
        verifyRequest,
        { "Content-Type": "application/json" },
        Math.min(timeoutMs, 15000)
      );

      if (!response.ok || !response.data) {
        return {
          allowed: false,
          reason: response.text || "CSRG verification failed",
        };
      }

      return response.data;
    },

    /**
     * Load persisted crypto policy state from disk.
     */
    async loadCachedState() {
      return await readJson(stateFilePath, null);
    },

    /**
     * Clear persisted crypto policy state.
     */
    async clearCache() {
      try {
        await writeJson(stateFilePath, null);
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert canonical policy IR statements into a plan structure for CSRG
 * hashing. The token binds the exact IR statement set; legacy flat rules are
 * accepted only through normalizePolicyIr's one-time migration path.
 */
function buildPolicyPlan(policy) {
  const ir = normalizePolicyIr(policy);
  const steps = ir.statements.map((statement) => ({
    action: `policy_statement:${statement.id}`,
    mcp: "armoriq-policy",
    description: `Policy statement: ${statement.effect} ${actionDescription(statement.action)}`,
    metadata: {
      statement_id: statement.id,
      statement_effect: statement.effect,
      action: statement.action,
      resource: statement.resource,
      conditions: statement.conditions,
    },
  }));

  if (steps.length === 0) {
    steps.push({
      action: "policy_default",
      mcp: "armoriq-policy",
      description: `Default policy decision: ${ir.defaults.decision}`,
      metadata: {
        default_decision: ir.defaults.decision,
        conflict_resolution: ir.defaults.conflictResolution,
      },
    });
  }

  return {
    steps,
    metadata: {
      goal: "ArmorIQ policy enforcement",
      policy_type: "crypto-bound",
      policy_schema: POLICY_IR_VERSION,
    },
  };
}

function actionDescription(action) {
  if (!isPlainObject(action)) return "*";
  if (typeof action.eq === "string") return action.eq;
  if (Array.isArray(action.in)) return action.in.join(",");
  return "*";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function describePostError(error, url, timeoutMs) {
  if (error?.name === "AbortError") {
    return `Request to ${url} timed out after ${timeoutMs}ms`;
  }
  return error instanceof Error ? error.message : String(error);
}

async function postJsonWithRetry(url, payload, headers, timeoutMs, maxRetries) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await postJson(url, payload, headers, timeoutMs);
      if (response.ok || !isRetriableHttpStatus(response.status) || attempt >= maxRetries) {
        return response;
      }
      lastError = new Error(response.text || `CSRG /intent failed with status ${response.status}`);
    } catch (error) {
      lastError = new Error(describePostError(error, url, timeoutMs));
      if (attempt >= maxRetries) {
        throw lastError;
      }
    }
    await sleep(75 * (attempt + 1));
  }
  throw lastError || new Error("CSRG /intent failed");
}
