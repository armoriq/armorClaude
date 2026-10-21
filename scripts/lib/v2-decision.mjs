import { buildAuthHeaders, isPlainObject, sha256Hex } from "./common.mjs";
import { enforceCall } from "./backend-client.mjs";
import { getSdkClient } from "./intent.mjs";
import { sdkModule } from "./sdk.mjs";
import { parseToolIdentity } from "./tool-registry.mjs";

// One cache per backend, key and agent. In the daemon it lives for the whole
// session, so the org's v2 bundle is fetched once and revalidated by ETag.
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

export function resetV2DecisionState() {
  caches.clear();
}

// The cache asks for an axios-shaped client; this one sends the plugin's own
// auth and client headers like every other backend call.
function bundleHttpClient(config) {
  return {
    async get(url, { params = {}, headers = {}, timeout = 10_000 } = {}) {
      const target = new URL(url);
      for (const [name, value] of Object.entries(params)) target.searchParams.set(name, value);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const res = await fetch(target, {
          headers: { ...buildAuthHeaders(config), ...headers },
          signal: controller.signal,
        });
        const data = res.status === 200 ? await res.json() : undefined;
        return { status: res.status, data, headers: { etag: res.headers.get("etag") ?? "" } };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** The tool name and server v2 rules key on: MCP tools by their own name, scoped to their server. */
export function v2Call(toolName) {
  const identity = parseToolIdentity(toolName);
  const mcp = identity.category === "external-mcp" || identity.category === "plugin-mcp";
  return mcp
    ? { tool: identity.toolName, mcpServer: identity.serverName }
    : { tool: toolName, mcpServer: undefined };
}

/**
 * The org's v2 verdict for one call, decided locally from the policy bundle.
 * A bundle that cannot be fetched, or is older than the SDK's stale limit,
 * decides `block`.
 */
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
  const { BUNDLE_REVALIDATE_MS } = sdkModule("policy-bundle");
  if (cache.state().status === "current") cache.refresh(BUNDLE_REVALIDATE_MS).catch(() => {});
  else await cache.refresh(0);
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

/**
 * A held call goes to the backend, the only place an approval is spent:
 * `approved_delegation` lets it run once, a rejection or expiry blocks it,
 * and a still-held call files one delegation request per call shape.
 */
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
