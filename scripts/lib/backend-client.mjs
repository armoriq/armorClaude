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

/** JSON fetch helper honoring the configured timeout + auth headers. */
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

/**
 * Push the caller's policy to the backend as a STAGED PROPOSAL, using the armor
 * profile lifecycle: PUT /policies/profiles/draft then POST
 * /policies/profiles/propose. Both accept the plugin API key.
 *
 * Activation is intentionally NOT performed here — a human confirms the staged
 * proposal from the dashboard (POST /policies/profiles/confirm is JWT-only).
 * This is what makes a policy set from the terminal land in the DB and show up
 * in the UI awaiting confirmation.
 */
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

/** Push a saved profile's policy to the backend as a staged proposal. */
export async function pushProfile(config, profile) {
  return proposePolicy(
    config,
    profile?.policy,
    `Profile "${profile?.profile?.name || "unnamed"}" proposed via /armor`
  );
}

/** Sync the current active policy to the backend as a staged proposal. */
export async function syncPolicy(config, policyState) {
  return proposePolicy(config, policyState?.policy, "Policy synced via /armor (terminal)");
}

/** Read the org's active armor policy (API-key scoped: GET profiles/active). */
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
