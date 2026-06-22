import { postJson, buildAuthHeaders } from "./common.mjs";

function endpoint(config, path) {
  const base = (config.backendEndpoint || "").replace(/\/+$/, "");
  return `${base}${path}`;
}

function hasBackend(config) {
  return Boolean(config.apiKey && config.backendEndpoint);
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

export async function pushProfile(config, profile) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured" };
  try {
    const res = await postJson(
      endpoint(config, "/policies/profiles"),
      profile,
      buildAuthHeaders(config),
      config.timeoutMs || 8000
    );
    return { ok: res.ok, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

export async function pullProfiles(config) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured", profiles: [] };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 8000);
    const res = await fetch(endpoint(config, "/policies/profiles"), {
      method: "GET",
      headers: buildAuthHeaders(config),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json().catch(() => null);
    return {
      ok: res.ok,
      status: res.status,
      profiles: Array.isArray(data?.profiles) ? data.profiles : Array.isArray(data) ? data : [],
    };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err), profiles: [] };
  }
}

export async function syncPolicy(config, policyState) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured" };
  try {
    const res = await postJson(
      endpoint(config, "/policies/sync"),
      {
        version: policyState.version,
        policy: policyState.policy,
        source: "armorclaude",
        updatedAt: policyState.updatedAt,
      },
      buildAuthHeaders(config),
      config.timeoutMs || 8000
    );
    return { ok: res.ok, status: res.status, data: res.data };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/**
 * Pull the org's ACTIVE armor.policy.v1 document, authored from the dashboard.
 * Read-only: the plugin never writes policy to the backend. Returns the
 * confirmed active document plus its version so the caller can skip applying
 * a policy that is not newer than what is already on disk.
 */
export async function pullActivePolicy(config) {
  if (!hasBackend(config)) return { ok: false, reason: "no backend configured", policy: null };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs || 8000);
    const res = await fetch(endpoint(config, "/policies/profiles/active"), {
      method: "GET",
      headers: buildAuthHeaders(config),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json().catch(() => null);
    return {
      ok: res.ok,
      status: res.status,
      policy: data?.policy || null,
      version: Number.isFinite(data?.version) ? data.version : 0,
      updatedBy: data?.updatedBy || "dashboard",
    };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err), policy: null };
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
