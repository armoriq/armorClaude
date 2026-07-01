/**
 * IAP Verification Service
 *
 * Abstraction over ArmorIQ IAP backend operations:
 *  - verifyStep:    POST /iap/verify-step
 *  - verifyWithCsrg: POST /verify/action (CSRG Merkle proof)
 *  - createAuditLog: POST /iap/audit
 *
 * Ported from ArmorClaw's IAPVerificationService (iap-verfication.service.ts).
 */

import {
  buildAuthHeaders,
  isPlainObject,
  parseStepIndex,
  postJson,
  readString,
} from "./common.mjs";

/**
 * Create an IAP service instance from config.
 */
export function createIapService(config) {
  const backendEndpoint =
    config.backendEndpoint || config.verifyStepEndpoint?.replace(/\/iap\/verify-step$/, "") || "";
  const csrgEndpoint = config.csrgEndpoint || "";
  const timeoutMs = config.timeoutMs || 8000;
  const headers = buildAuthHeaders(config);

  return {
    /**
     * Verify a tool execution step with the IAP backend.
     * Equivalent to ArmorClaw IAPVerificationService.verifyStep()
     */
    async verifyStep(intentTokenRaw, csrgProofs, toolName) {
      const endpoint = config.verifyStepEndpoint;
      if (!endpoint || !config.csrgVerifyEnabled) {
        return { skipped: true };
      }

      const { token, tokenObj } = getTokenForVerification(intentTokenRaw);
      if (!token) {
        return { skipped: false, allowed: false, reason: "ArmorIQ intent token missing" };
      }

      const payload = { token };
      if (csrgProofs?.path) {
        payload.path = csrgProofs.path;
        const stepMatch = csrgProofs.path.match(/\/steps\/\[(\d+)\]/);
        if (stepMatch) {
          payload.step_index = Number.parseInt(stepMatch[1] || "0", 10);
        }
      }
      if (toolName) {
        payload.tool_name = toolName;
      }
      if (Array.isArray(csrgProofs?.proof)) {
        payload.proof = csrgProofs.proof;
      }
      if (csrgProofs?.valueDigest) {
        payload.context = {
          csrg_value_digest: csrgProofs.valueDigest,
          proof_source: "client",
        };
      }

      const response = await postJson(endpoint, payload, headers, timeoutMs);
      if (!response.ok && !isPlainObject(response.data)) {
        throw new Error(response.text || `IAP verify-step failed with status ${response.status}`);
      }

      const data = isPlainObject(response.data) ? response.data : {};
      const tokenRaw =
        typeof data.intentTokenRaw === "string"
          ? data.intentTokenRaw
          : typeof data.tokenRaw === "string"
            ? data.tokenRaw
            : isPlainObject(data.token)
              ? JSON.stringify(data.token)
              : undefined;
      const parsedFromResponse = tokenRaw ? extractPlanFromResponse(tokenRaw) : null;
      const fallbackPlan = isPlainObject(tokenObj?.plan)
        ? tokenObj.plan
        : isPlainObject(tokenObj?.rawToken?.plan)
          ? tokenObj.rawToken.plan
          : undefined;
      const stepIndex =
        parseStepIndex(data?.step?.step_index) ??
        parseStepIndex(data?.execution_state?.current_step) ??
        parseStepIndexFromPath(csrgProofs?.path) ??
        undefined;

      return {
        skipped: false,
        allowed: data.allowed !== false,
        reason: typeof data.reason === "string" ? data.reason : "",
        policyValidation: extractPolicyValidation(data, tokenObj),
        tokenRaw,
        plan: isPlainObject(data.plan) ? data.plan : parsedFromResponse?.plan || fallbackPlan,
        expiresAt: Number.isFinite(data.expiresAt) ? data.expiresAt : parsedFromResponse?.expiresAt,
        stepIndex,
      };
    },

    /**
     * Verify action directly with CSRG service using Merkle proof.
     * Equivalent to ArmorClaw IAPVerificationService.verifyWithCsrg()
     */
    async verifyWithCsrg(path, value, proof, token, context) {
      if (!config.csrgVerifyEnabled) {
        throw new Error("CSRG verification is disabled");
      }

      const payload = { path, value, proof, token, context };
      const response = await postJson(
        `${csrgEndpoint}/verify/action`,
        payload,
        { "Content-Type": "application/json" },
        Math.min(timeoutMs, 15000)
      );

      if (response.ok && response.data) {
        return response.data;
      }

      if (response.data) {
        return {
          allowed: false,
          reason:
            response.data.reason || `CSRG verification failed: ${response.text || "unknown error"}`,
        };
      }

      return {
        allowed: false,
        reason: response.text
          ? `CSRG verification failed: ${response.text}`
          : `CSRG verification failed with status ${response.status}`,
      };
    },

    /**
     * Create an audit log entry in the IAP service.
     * Equivalent to ArmorClaw IAPVerificationService.createAuditLog()
     */
    async createAuditLog(dto) {
      const response = await postJson(`${backendEndpoint}/iap/audit`, dto, headers, timeoutMs);

      if (!response.ok || !response.data) {
        const message = response.text
          ? `IAP audit creation failed: ${response.text}`
          : `IAP audit creation failed with status ${response.status}`;
        throw new Error(message);
      }

      return response.data;
    },

    /**
     * Phase 4 C2: send N audit DTOs in one HTTP roundtrip.
     * Used by armorclaude-daemon's audit-buffer flush. The daemon batches
     * up to 100 rows or 5s, whichever first, then ships them here.
     *
     * Returns { written, failures } so the daemon knows whether to
     * re-queue any rows that failed.
     */
    async createAuditLogBatch(rows) {
      if (!Array.isArray(rows) || rows.length === 0) {
        return { written: 0, failures: [] };
      }
      const response = await postJson(
        `${backendEndpoint}/iap/audit/batch`,
        { rows },
        headers,
        timeoutMs
      );
      if (!response.ok || !response.data) {
        const message = response.text
          ? `IAP audit batch failed: ${response.text}`
          : `IAP audit batch failed with status ${response.status}`;
        throw new Error(message);
      }
      return response.data;
    },

    csrgProofsRequired() {
      return Boolean(config.requireCsrgProofs);
    },

    csrgVerifyIsEnabled() {
      return Boolean(config.csrgVerifyEnabled);
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getTokenForVerification(intentTokenRaw) {
  if (typeof intentTokenRaw !== "string") {
    return { token: "", tokenObj: null };
  }
  try {
    const parsed = JSON.parse(intentTokenRaw);
    if (isPlainObject(parsed)) {
      const jwtToken = readString(parsed.jwtToken) || readString(parsed.jwt_token);
      if (jwtToken) {
        return { token: jwtToken, tokenObj: parsed };
      }
      return { token: intentTokenRaw, tokenObj: parsed };
    }
    return { token: intentTokenRaw, tokenObj: null };
  } catch {
    return { token: intentTokenRaw, tokenObj: null };
  }
}

function extractPlanFromResponse(tokenRaw) {
  try {
    const parsed = JSON.parse(tokenRaw);
    if (!isPlainObject(parsed)) return null;
    const plan = isPlainObject(parsed.plan)
      ? parsed.plan
      : isPlainObject(parsed.rawToken?.plan)
        ? parsed.rawToken.plan
        : null;
    const expiresAt = Number.isFinite(parsed.expiresAt)
      ? parsed.expiresAt
      : Number.isFinite(parsed.token?.expires_at)
        ? parsed.token.expires_at
        : undefined;
    return plan ? { plan, expiresAt } : null;
  } catch {
    return null;
  }
}

function extractPolicyValidation(data, tokenObj) {
  const candidates = [
    data?.policyValidation,
    data?.policy_validation,
    data?.token?.policyValidation,
    data?.token?.policy_validation,
    tokenObj?.policyValidation,
    tokenObj?.policy_validation,
    tokenObj?.rawToken?.policyValidation,
    tokenObj?.rawToken?.policy_validation,
    tokenObj?.rawToken?.token?.policyValidation,
    tokenObj?.rawToken?.token?.policy_validation,
  ];
  return candidates.find((candidate) => isPlainObject(candidate)) || undefined;
}

function parseStepIndexFromPath(path) {
  if (!path) return null;
  const match = path.match(/\/steps\/\[(\d+)\]/);
  if (!match) return null;
  const index = Number.parseInt(match[1] || "", 10);
  return Number.isFinite(index) ? index : null;
}

// ---------------------------------------------------------------------------
// Trust Update primitives (Phase 3) — thin wrappers over the SDK methods
// already shipped in @armoriq/sdk's Client. All three are best-effort: a
// failure logs and returns { ok: false }; it never throws to the caller.
// The hook handlers must not block on Trust Update plumbing failures.
// ---------------------------------------------------------------------------

/**
 * Sign a ReAnchor delta linking the previous plan hash to the new one.
 * Returns { ok, trustId?, fromHash?, toHash? }.
 *
 * @param {object} args
 * @param {(config:any)=>any} args.getClient — getSdkClient resolver (passed in
 *   to avoid a circular import between iap-service.mjs and intent.mjs).
 * @param {object} args.config
 * @param {object} args.intentToken — current intent token (raw object, parsed)
 * @param {object} args.updatedPlan — the new plan structure
 * @param {string} [args.reason]
 */
export async function reanchorViaSdk({ getClient, config, intentToken, updatedPlan, reason }) {
  if (!intentToken || !updatedPlan) {
    return { ok: false, error: "missing intentToken or updatedPlan" };
  }
  if (!config?.apiKey || !config?.useSdkIntent) {
    return { ok: false, error: "sdk-disabled" };
  }
  try {
    const client = getClient(config);
    if (typeof client?.reanchor !== "function") {
      return { ok: false, error: "client.reanchor not available" };
    }
    const result = await client.reanchor(intentToken, updatedPlan, reason);
    return {
      ok: true,
      trustId: result?.trustId,
      fromHash: result?.delta?.payload?.from_hash,
      toHash: result?.delta?.payload?.to_hash,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      status: err?.response?.status,
      body: err?.response?.data,
    };
  }
}

/**
 * Sign a Revoke delta for the given token, propagating to PEPs. Accepts
 * either a full intent token object OR a planId/tokenId for operator-driven
 * revocation (the controller in conmap-auto handles either shape).
 */
export async function revokeViaSdk({
  getClient,
  config,
  intentToken,
  planId,
  tokenId,
  reason,
  cascade,
}) {
  if (!config?.apiKey || !config?.useSdkIntent) {
    return { ok: false, error: "sdk-disabled" };
  }
  try {
    const client = getClient(config);
    if (typeof client?.revoke !== "function") {
      return { ok: false, error: "client.revoke not available" };
    }
    // The SDK's revoke signature takes an IntentToken; if only planId/tokenId
    // is available (operator path), synthesize a minimal token shape that the
    // backend's relaxed RevokeDto will accept.
    const token = intentToken ?? {
      tokenId: tokenId,
      token_id: tokenId,
      planHash: undefined,
      signature: tokenId || planId || "unknown",
      issuedAt: 0,
      expiresAt: 0,
      policy: {},
      compositeIdentity: "",
      stepProofs: [],
      totalSteps: 0,
      rawToken: { token: { token_id: tokenId, planId } },
    };
    const result = await client.revoke(token, reason || "armorclaude", {
      cascade: !!cascade,
      planId,
    });
    return {
      ok: true,
      trustId: result?.trustId,
      cascadedRevocations: result?.cascadedRevocations,
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Issue a subtree-bounded delegated token + Merkle inclusion proof.
 */
export async function delegateSubtreeViaSdk({ getClient, config, intentToken, opts }) {
  if (!intentToken || !opts?.delegatePublicKey || !opts?.subtreePath) {
    return { ok: false, error: "missing intentToken / delegatePublicKey / subtreePath" };
  }
  if (!config?.apiKey || !config?.useSdkIntent) {
    return { ok: false, error: "sdk-disabled" };
  }
  try {
    const client = getClient(config);
    if (typeof client?.delegateSubtree !== "function") {
      return { ok: false, error: "client.delegateSubtree not available" };
    }
    const result = await client.delegateSubtree(intentToken, opts);
    return {
      ok: true,
      trustId: result?.trustId,
      delegationId: result?.delegationId,
      inclusionProof: result?.inclusionProof,
      subtreeRoot: result?.subtreeRoot,
      delegatedToken: result?.delegatedToken,
    };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}
