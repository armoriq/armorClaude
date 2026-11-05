import { postJson, buildAuthHeaders } from "./common.mjs";

function endpoint(config, path) {
  const base = (config.backendEndpoint || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

function hasBackend(config) {
  return Boolean(config.apiKey && config.backendEndpoint);
}

export async function enforceCall(config, body) {
  return jsonRequest(config, "POST", "/iap/sdk/enforce", body);
}

export async function autoRegisterMcp(config, serverName) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured" };
  try {
    const res = await postJson(
      endpoint(config, "/mcp/auto-register"),
      { mcpName: serverName, source: "armorclaude-autodetect" },
      buildAuthHeaders(config),
      config.timeoutMs || 8000
    );
    return { ok: res.ok, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

async function jsonRequest(config, method, apiPath, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 8000);
  try {
    const res = await fetch(endpoint(config, apiPath), {
      method,
      headers: buildAuthHeaders(config),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

export async function proposePolicy(config, policy, reason) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured" };
  if (!policy) return { ok: false, reason: "no policy to propose" };
  try {
    const draft = await jsonRequest(config, "PUT", "/policies/profiles/draft", {
      policy,
      orgId: config.orgId || undefined,
    });
    if (!draft.ok) {
      return { ok: false, status: draft.status, reason: `draft failed: HTTP ${draft.status}` };
    }
    const proposal = await jsonRequest(config, "POST", "/policies/profiles/propose", {
      reason: reason || "Updated via /armor (terminal)",
      orgId: config.orgId || undefined,
    });
    if (!proposal.ok) {
      return {
        ok: false,
        status: proposal.status,
        reason: `propose failed: HTTP ${proposal.status}`,
      };
    }
    return { ok: true, status: proposal.status, data: proposal.data };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

export async function pushProfile(config, profile) {
  return proposePolicy(
    config,
    profile?.policy,
    `Profile "${profile?.profile?.name || "unnamed"}" proposed via /armor`
  );
}

export async function syncPolicy(config, policyState) {
  return proposePolicy(config, policyState?.policy, "Policy synced via /armor (terminal)");
}

export async function pullProfiles(config) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured", profiles: [] };
  try {
    const res = await jsonRequest(config, "GET", "/policies/profiles/active");
    const policy = res.data?.policy;
    const profiles = policy
      ? [{ profile: { name: "active", description: "Active org policy" }, policy }]
      : [];
    return { ok: res.ok, status: res.status, profiles };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err), profiles: [] };
  }
}

export async function syncMcpRegistry(config) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured", servers: [] };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 8000);
    const res = await fetch(endpoint(config, "/mcp/servers"), {
      method: "GET",
      headers: buildAuthHeaders(config),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json().catch(() => null);
    return {
      ok: res.ok,
      status: res.status,
      servers: Array.isArray(data?.servers) ? data.servers : Array.isArray(data) ? data : [],
    };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err), servers: [] };
  }
}

export async function keyOwner(config) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured" };
  try {
    const res = await postJson(
      endpoint(config, "/iap/validate-key"),
      {},
      buildAuthHeaders(config),
      config.timeoutMs || 8000
    );
    const userId = res.data?.userId;
    if (!res.ok) return { ok: false, reason: `validate-key returned ${res.status}` };
    if (typeof userId !== "string" || !userId)
      return { ok: false, reason: "validate-key returned no userId" };
    return { ok: true, userId };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

export async function pendingHistorySync(config, deviceId) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 8000);
  try {
    const query = `?deviceId=${encodeURIComponent(deviceId)}`;
    const res = await fetch(endpoint(config, `/api-keys/device-history-sync${query}`), {
      headers: buildAuthHeaders(config),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, reason: `device-history-sync returned ${res.status}` };
    return {
      ok: true,
      requestedAt: typeof data?.requestedAt === "string" ? data.requestedAt : null,
      requestId: typeof data?.requestId === "string" ? data.requestId : null,
    };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    clearTimeout(timeout);
  }
}
