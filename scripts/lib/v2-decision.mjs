import { buildAuthHeaders, isPlainObject, sha256Hex } from "./common.mjs";
import { enforceCall } from "./backend-client.mjs";
import { getSdkClient } from "./intent.mjs";
import { sdkModule } from "./sdk.mjs";
import { parseToolIdentity } from "./tool-registry.mjs";
import { statusCommand } from "./config.mjs";
import {
  BACKEND_TIMEOUT_MS,
  UNREACHABLE_FOR_MS,
  backendUnreachable,
  capabilityOf,
  noteBackendStatus,
  noteBackendUnreachable,
  signedOut,
} from "./backend-posture.mjs";

const caches = new Map();

function bundleCache(config) {
  const key = `${config.backendEndpoint} ${config.agentId} ${sha256Hex(config.apiKey).slice(0, 16)}`;
  if (!caches.has(key)) {
    const { PolicyBundleCache } = sdkModule("policy-bundle");
    if (typeof PolicyBundleCache !== "function") return null;
    caches.set(
      key,
      new PolicyBundleCache(() => ({
        httpClient: bundleHttpClient(config),
        backendEndpoint: config.backendEndpoint,
        apiKey: config.apiKey,
        agentId: config.agentId,
      }))
    );
  }
  return caches.get(key);
}

function bundleHttpClient(config) {
  return {
    async get(url, { params = {}, headers = {} } = {}) {
      const target = new URL(url);
      for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
      try {
        const res = await fetch(target, {
          headers: { ...buildAuthHeaders(config), ...headers },
          signal: controller.signal,
        }).catch((err) => {
          noteBackendUnreachable(config);
          throw err;
        });
        noteBackendStatus(config, res.status);
        const data = res.status === 200 ? await res.json() : undefined;
        return { status: res.status, data, headers: { etag: res.headers.get("etag") ?? "" } };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function v2Call(toolName) {
  const identity = parseToolIdentity(toolName);
  const mcp = identity.category === "external-mcp" || identity.category === "plugin-mcp";
  return mcp
    ? { tool: identity.toolName, mcpServer: identity.serverName }
    : { tool: toolName, mcpServer: undefined };
}

export function unreachableReason(config, toolName) {
  return (
    `ArmorIQ backend ${config.backendEndpoint} is unreachable (backend_unreachable), so ${toolName} ` +
    `waits until it answers again; it is rechecked every ${UNREACHABLE_FOR_MS / 1000} seconds and reads still run. ` +
    `Check the connection: ${statusCommand()}`
  );
}

export async function decideV2(config, toolName, toolArgs) {
  const cache = bundleCache(config);
  const { decideLocally } = sdkModule("local-decision");
  if (!cache || typeof decideLocally !== "function") {
    return {
      allowed: false,
      action: "block",
      reason: "policy-bundle-unavailable: the installed @armoriq/sdk-dev has no v2 evaluator",
    };
  }
  const read = capabilityOf(toolName) === "read";
  if (!backendUnreachable(config)) {
    const { BUNDLE_REVALIDATE_MS } = sdkModule("policy-bundle");
    if (read && cache.state().status === "current") {
      cache.refresh(BUNDLE_REVALIDATE_MS).catch(() => {});
    } else {
      await cache.refresh(read ? 0 : UNREACHABLE_FOR_MS);
    }
  }
  if (signedOut(config)) return { allowed: true, action: "allow", reason: "signed_out" };
  if (backendUnreachable(config)) {
    if (!read) {
      return {
        allowed: false,
        action: "block",
        code: "backend_unreachable",
        reason: unreachableReason(config, toolName),
      };
    }
    if (cache.state().status !== "current") {
      return { allowed: true, action: "allow", reason: "backend_unreachable" };
    }
  }
  const state = cache.state();
  if (state.status === "current" && !state.agent) {
    return { allowed: true, action: "allow", reason: "no_v2_policy" };
  }
  const { tool, mcpServer } = v2Call(toolName);
  return decideLocally(state, {
    agentId: config.agentId,
    tool,
    arguments: isPlainObject(toolArgs) ? toolArgs : {},
    mcpServer,
    userEmail: config.userEmail || undefined,
  });
}

function signedToken(intentTokenRaw) {
  try {
    const token = JSON.parse(intentTokenRaw);
    return { jwt_token: token.jwtToken, plan_id: token.planId ?? token.rawToken?.plan_id };
  } catch {
    return null;
  }
}

export async function resolveV2Hold(config, { intentTokenRaw, toolName, toolArgs, session }) {
  const intentToken = intentTokenRaw ? signedToken(intentTokenRaw) : null;
  if (!intentToken?.plan_id) {
    return {
      action: "hold",
      reason: `ArmorIQ policy holds ${toolName} for approval, but this session has no intent plan to attach the request to. Call register_intent_plan, then retry.`,
    };
  }
  const { tool, mcpServer } = v2Call(toolName);
  const args = isPlainObject(toolArgs) ? toolArgs : {};
  const res = await enforceCall(config, {
    tool,
    mcp: mcpServer ?? config.mcpName,
    arguments: args,
    intent_token: intentToken,
    agent_id: config.agentId,
    user_email: config.userEmail || undefined,
  });
  const verdict = isPlainObject(res.data) ? res.data : {};
  if (!res.ok) {
    return {
      action: "block",
      reason: `ArmorIQ enforce failed for ${toolName} (HTTP ${res.status})`,
    };
  }
  if (verdict.allowed === true) return { action: "allow", reason: verdict.reason || "allowed" };
  if (verdict.enforcementAction !== "hold") {
    return { action: "block", reason: verdict.message || verdict.reason || "blocked" };
  }
  const filed = await fileDelegation(config, {
    session,
    intentToken,
    tool,
    domain: mcpServer ?? config.mcpName,
    args,
    reason: verdict.reason,
  });
  return {
    action: "hold",
    reason:
      `ArmorIQ policy holds ${toolName} for approval (${verdict.reason}). ` +
      (filed.delegationId
        ? `Approval request ${filed.delegationId} is waiting for another member; retry after it is approved.`
        : `The approval request could not be filed: ${filed.error}.`),
  };
}

async function fileDelegation(config, { session, intentToken, tool, domain, args, reason }) {
  const shape = sha256Hex(JSON.stringify([intentToken.plan_id, domain, tool, args]));
  const filed = isPlainObject(session.v2Delegations) ? session.v2Delegations : {};
  if (filed[shape]) return { delegationId: filed[shape] };
  if (!config.userEmail) return { error: "the signed-in profile has no email" };
  try {
    const client = getSdkClient(config);
    const role = await client.resolveUserRole(config.userEmail).catch(() => null);
    const result = await client.createDelegationRequest({
      tool,
      action: "execute",
      arguments: args,
      requesterEmail: config.userEmail,
      requesterRole: role?.role || "agent_user",
      requesterLimit: role?.limit ?? 0,
      domain,
      planId: intentToken.plan_id,
      reason,
    });
    session.v2Delegations = { ...filed, [shape]: result.delegationId };
    return { delegationId: result.delegationId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
