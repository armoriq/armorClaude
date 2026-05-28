/**
 * OPA HTTP client for ArmorClaude enforcement.
 * Modeled on armoriq-proxy-server/src/policy-enforcement/opa-client.service.ts.
 *
 * Features: response cache, circuit breaker, fail-closed on error.
 */

const cache = new Map();
let consecutiveFailures = 0;
let circuitOpenUntil = 0;

export function resetOpaClientState() {
  cache.clear();
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

export async function evaluateOpa(config, opaInput) {
  const pdpUrl = config.opaPdpUrl;
  if (!pdpUrl) {
    return { allowed: false, reason: "OPA PDP URL not configured" };
  }

  const threshold = config.opaCircuitBreakerThreshold || 15;
  const resetMs = config.opaCircuitResetMs || 10000;
  const cacheTtl = config.opaCacheTtlMs || 10000;
  const timeoutMs = config.opaTimeoutMs || 3000;

  if (Date.now() < circuitOpenUntil) {
    return { allowed: false, reason: "OPA circuit breaker open — fail-closed" };
  }

  const cacheKey = `${opaInput.resource?.toolName || ""}:${opaInput.resource?.resourceType || ""}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.decision;
  }

  const url = `${pdpUrl.replace(/\/+$/, "")}/v1/data/armoriq/authz/decision`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: opaInput }),
      signal: controller.signal
    });
    clearTimeout(timer);

    const data = await response.json().catch(() => null);
    const result = data?.result;

    consecutiveFailures = 0;

    if (!result || typeof result !== "object") {
      return { allowed: false, reason: "OPA returned empty result — fail-closed" };
    }

    const decision = {
      allowed: result.allow === true,
      reason: result.allow ? "opa_allow" : (result.reason || "opa_deny"),
      matchedPolicy: result.matched_policy || null
    };

    cache.set(cacheKey, { decision, expiresAt: Date.now() + cacheTtl });
    return decision;
  } catch (err) {
    consecutiveFailures++;
    if (consecutiveFailures >= threshold) {
      circuitOpenUntil = Date.now() + resetMs;
    }
    return { allowed: false, reason: `OPA unreachable — fail-closed (${err?.message || err})` };
  }
}
