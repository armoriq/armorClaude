import { createHash, randomUUID } from "node:crypto";
import { capabilityOf } from "./backend-posture.mjs";
import { withBackendPosture } from "./config.mjs";
import { decisionCode } from "./decision-codes.mjs";
import { createAuditWal, fitAuditRow, loginTag, recordCaptureFailure } from "./audit-wal.mjs";

// conmap-auto mirrors this UUID namespace in block-capture-v1.json.
const NAMESPACE = Buffer.from("38e3839fd44e5317b41fb2738b0a247a", "hex");

function rowId(name) {
  const bytes = createHash("sha1").update(NAMESPACE).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createAuditEnvelope(input = {}) {
  const root = input.root_session_id || input.parent_session_id || input.session_id || "";
  const call =
    typeof input.tool_use_id === "string" && input.tool_use_id ? input.tool_use_id : randomUUID();
  return {
    decisionId: rowId(`${root}:${call}:decision`),
    resultId: rowId(`${root}:${call}:result`),
    executed_at: new Date().toISOString(),
  };
}

export function snapshotAuditContext(envelope, session = {}) {
  let legacyPlanId;
  if (!session.promptId) {
    try {
      legacyPlanId = JSON.parse(session.intentTokenRaw).planId;
    } catch {
      // Sessions without a token have no legacy plan identity.
    }
  }
  const planId = session.tokenPlanId || legacyPlanId || undefined;
  const contextId = session.countedPlanId || undefined;
  return {
    ...envelope,
    contextCaptured: true,
    plan_id: planId,
    context_plan_id: contextId !== planId ? contextId : undefined,
    prompt_id: session.promptId || undefined,
  };
}

/**
 * Emit an audit row. Routing order:
 *   1. daemon (if enabled and reachable) → await its durable WAL receipt
 *   2. WAL directly (when the daemon path fails) → durable, recoverable
 *
 * Returns the capture target, signed out status or capture failure status for debug logging.
 */
export async function emitAudit({ dto: row, config, fallback = false }) {
  if (config.signedOut) return "signed out";
  if (!config.backendEndpoint || !config.apiKey) {
    await recordCaptureFailure(
      config.dataDir,
      row.decision_code || "internal_error",
      row.executed_at
    );
    return "capture failure";
  }
  const captured = fallback ? row : { ...row, capability: capabilityOf(row.tool) };
  const dto = fitAuditRow(captured);
  if (config.daemonEnabled && dto) {
    try {
      const { enqueueAuditViaDaemon } = await import("./daemon-client.mjs");
      const ok = await enqueueAuditViaDaemon({ dto, config, fallback });
      if (ok) return "enqueued (daemon)";
    } catch (err) {
      if (config.debug)
        process.stderr.write(`[armorclaude] audit daemon enqueue failed: ${err?.message ?? err}\n`);
    }
  }
  try {
    const login = loginTag(config.backendEndpoint, config.apiKey);
    const wal = createAuditWal({
      dataDir: config.dataDir,
      login,
      binding: { backend: config.backendEndpoint, keyId: login },
    });
    await wal.appendLine(captured, { fallback });
    return "written (wal)";
  } catch (error) {
    await recordCaptureFailure(
      config.dataDir,
      row.decision_code || "internal_error",
      row.executed_at
    );
    error.captureFailureRecorded = true;
    throw error;
  }
}

export async function captureFallback(input, config, code, envelope = createAuditEnvelope(input)) {
  config = withBackendPosture(config);
  if (config.signedOut || (config.unconfigured && !config.apiKey && !config.hadUnusableKey)) return;
  if (!config.apiKey || !config.userId) {
    await recordCaptureFailure(config.dataDir, code, envelope.executed_at);
    return;
  }
  if (!config.auditEnabled) return;
  await emitAudit({
    config,
    fallback: true,
    dto: {
      client_row_id: envelope.decisionId,
      plan_id: envelope.plan_id,
      context_plan_id: envelope.context_plan_id,
      prompt_id: envelope.prompt_id,
      session_id: typeof input?.session_id === "string" ? input.session_id : undefined,
      user_id: config.userId,
      agent_id: config.agentId,
      client_id: config.mcpName || config.llmId,
      tool: "unknown",
      action: "unknown",
      input: {},
      output: null,
      status: "blocked",
      decision_code: decisionCode(code),
      error_message: code,
      executed_at: envelope.executed_at,
      duration_ms: 0,
    },
  });
}
