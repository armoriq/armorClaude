import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "./lib/config.mjs";
import { writeJson } from "./lib/fs-store.mjs";
import { extractAllowedActions, getSdkClient, requestIntent } from "./lib/intent.mjs";
import { delegateSubtreeViaSdk, reanchorViaSdk, revokeViaSdk } from "./lib/iap-service.mjs";
import { loadRuntimeState, appendTrustOp, saveRuntimeState } from "./lib/runtime-state.mjs";
import { INTENT_PLAN_ZOD, PLAN_STEP_SCHEMA, normalizeIntentPlan } from "./lib/intent-schema.mjs";
import { computePolicyHash, loadPolicyState } from "./lib/policy.mjs";

const INTENT_POLICY_COMPILER_VERSION = "sdk-csrg-policy-v1";

function toTextResult(text, extra = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      message: text,
      ...extra
    }
  };
}

/**
 * Some MCP clients (and Claude itself) sometimes pass complex tool arguments
 * as JSON-encoded strings instead of structured objects. Accept either form.
 *
 *   { goal: "...", steps: "[{...}]" }   → parse steps as JSON
 *   { plan:  "{\"goal\":...}" }         → parse plan envelope as JSON
 *   { goal: "...", steps: [{...}] }     → pass through
 */
function coercePlanArgs(args) {
  if (!args || typeof args !== "object") {
    return args;
  }
  // If caller wrapped the entire plan in a `plan` field (string or object),
  // unwrap it.
  if (args.plan !== undefined) {
    let unwrapped = args.plan;
    if (typeof unwrapped === "string") {
      try { unwrapped = JSON.parse(unwrapped); } catch { /* fall through */ }
    }
    if (unwrapped && typeof unwrapped === "object") {
      args = { ...unwrapped, ...args };
      delete args.plan;
    }
  }
  // Coerce stringified arrays/objects on known fields.
  if (typeof args.steps === "string") {
    try { args = { ...args, steps: JSON.parse(args.steps) }; } catch { /* leave as-is */ }
  }
  return args;
}

async function loadStateAndConfig() {
  const config = loadConfig();
  const state = await loadPolicyState(config.policyFile);
  return { config, state };
}

async function run() {
  const server = new McpServer({
    name: "armorclaude-policy",
    version: "0.1.0"
  });

  server.registerTool(
    "policy_read",
    {
      title: "Policy Read",
      description: "Read current ArmorClaude policy state",
      inputSchema: {
        id: z.string().optional()
      }
    },
    async (args) => {
      const { state } = await loadStateAndConfig();
      if (typeof args.id === "string" && args.id.trim()) {
        const rule = state.policy.rules.find((entry) => entry.id === args.id.trim());
        if (!rule) {
          return toTextResult(`Policy rule not found: ${args.id}`);
        }
        return toTextResult(JSON.stringify(rule, null, 2), { rule });
      }
      return toTextResult(JSON.stringify(state, null, 2), {
        version: state.version,
        rules: state.policy.rules
      });
    }
  );

  // -----------------------------------------------------------------
  // register_intent_plan — Claude calls this to declare its plan
  // -----------------------------------------------------------------
  server.registerTool(
    "register_intent_plan",
    {
      title: "Register Intent Plan",
      description:
        "Declare the tools you intend to use for this task. " +
        "Required by ArmorClaude before any other tool call. " +
        "Without a registered plan, all tool calls will be blocked.",
      // Accept the canonical {goal, steps} shape AND the string-serialized
      // variants Claude sometimes emits (steps as a JSON string, or the
      // whole plan wrapped in a `plan` field). The handler below coerces
      // them to the canonical shape before validating with INTENT_PLAN_ZOD.
      inputSchema: {
        goal: z.string().min(1).optional()
          .describe("One-line summary of what the plan accomplishes"),
        steps: z.union([
          z.array(PLAN_STEP_SCHEMA).min(1),
          z.string().min(1)
        ]).optional()
          .describe("Ordered list of tool calls (array, or JSON-stringified array)"),
        plan: z.union([INTENT_PLAN_ZOD, z.string().min(1)]).optional()
          .describe("Alternative: pass the whole plan as an object or JSON string")
      }
    },
    async (args) => {
      // Claude sometimes serializes complex tool arguments as JSON strings
      // (e.g. steps: "[{...}]" instead of steps: [{...}]). Tolerate both.
      const coerced = coercePlanArgs(args);
      const parsed = INTENT_PLAN_ZOD.safeParse(coerced);
      if (!parsed.success) {
        return toTextResult(`Plan rejected: ${parsed.error.message}`);
      }

      const config = loadConfig();
      const plan = normalizeIntentPlan(parsed.data);

      // Send to ArmorIQ for signed intent token (if SDK/endpoint configured)
      let intentResult = { skipped: true };
      let policyHash = "";
      if (config.apiKey) {
        try {
          const policyState = await loadPolicyState(config.policyFile);
          policyHash = computePolicyHash(policyState.policy);
          intentResult = await requestIntent(config, {
            prompt: parsed.data.goal,
            plan,
            session_id: "mcp",
            policy_hash: policyHash,
            policy: policyState.policy,
            validitySeconds: config.validitySeconds,
            metadata: { source: "claude-code", planning: "claude-registered" }
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[armorclaude] intent capture in register_intent_plan: ${msg}\n`);
        }
      }

      const sessionId = process.env.CLAUDE_CODE_SESSION_ID || "";
      const pendingFile = sessionId
        ? `pending-plan.${sessionId}.json`
        : "pending-plan.json";
      const pendingPath = path.join(config.dataDir, pendingFile);
      await writeJson(pendingPath, {
        sessionId: sessionId || undefined,
        plan: intentResult.plan || plan,
        tokenRaw: intentResult.tokenRaw || "",
        allowedActions: Array.from(extractAllowedActions(intentResult.plan || plan)),
        expiresAt: intentResult.expiresAt,
        policyHash,
        intentPolicyCompilerVersion: INTENT_POLICY_COMPILER_VERSION,
        registeredAt: Date.now()
      });

      const tokenInfo = intentResult.tokenRaw
        ? `Token valid ${config.validitySeconds}s.`
        : "No ArmorIQ backend configured — plan stored locally.";

      return toTextResult(
        `Intent registered: ${plan.steps.length} steps. ${tokenInfo}`,
        { steps: plan.steps.length, goal: parsed.data.goal }
      );
    }
  );

  // -----------------------------------------------------------------
  // Trust Update primitives — operator/LLM can revoke, reanchor, or
  // delegate the active intent token directly from a Claude Code chat.
  // All three resolve the active session by reading the runtime file
  // (the MCP server is a long-lived stdio process, separate from the
  // hook handlers, so we re-read on every call).
  // -----------------------------------------------------------------

  async function resolveActiveSession() {
    const config = loadConfig();
    const runtimeState = await loadRuntimeState(config.runtimeFile);
    const sessions = runtimeState.sessions || {};

    // Prefer the current Claude Code window's session id when set. With
    // multiple concurrent windows the "most-recent updatedAt" heuristic
    // would route trust_revoke / trust_reanchor / trust_delegate against
    // the wrong window's token. CLAUDE_CODE_SESSION_ID is stamped on the
    // per-session pending-plan file (#43) and is reliable here.
    const envSid = process.env.CLAUDE_CODE_SESSION_ID || "";
    if (envSid && sessions[envSid]) {
      return {
        config,
        runtimeState,
        sessionId: envSid,
        session: sessions[envSid],
      };
    }

    // Fallback: pick the most-recently-updated session. Only reached when
    // the env var is missing (single-window dev) or points at a session
    // that's been GC'd from runtime.json.
    let chosen = null;
    let chosenId = null;
    for (const [sid, s] of Object.entries(sessions)) {
      if (!chosen || (s.updatedAt || 0) > (chosen.updatedAt || 0)) {
        chosen = s;
        chosenId = sid;
      }
    }
    return { config, runtimeState, sessionId: chosenId, session: chosen };
  }

  function parseToken(raw) {
    if (!raw || typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  server.registerTool(
    "trust_revoke",
    {
      title: "Revoke active intent token (Trust Update)",
      description:
        "Sign and broadcast a revocation delta for the currently active " +
        "intent token. Within Δ (paper-measured ~55 ms) every PEP in the " +
        "fleet refuses the token. Use when the user says \"stop\" or when " +
        "the plan has gone wrong.",
      inputSchema: {
        reason: z.string().min(1).describe("Why this revocation is happening"),
        cascade: z
          .boolean()
          .optional()
          .describe("If true, also revoke any subtree-delegated child tokens")
      }
    },
    async (args) => {
      const { config, runtimeState, sessionId, session } = await resolveActiveSession();
      if (!session) {
        return toTextResult("No active session — nothing to revoke.");
      }
      const intentToken = parseToken(session.intentTokenRaw);
      if (!intentToken) {
        return toTextResult(
          "No parsed intent token on the active session — cannot revoke. " +
          "Make sure a plan has been registered for this Claude Code session."
        );
      }
      const result = await revokeViaSdk({
        getClient: getSdkClient,
        config,
        intentToken,
        reason: args.reason,
        cascade: args.cascade
      });
      appendTrustOp(runtimeState, sessionId, {
        operation: "Revoke",
        trustId: result.trustId,
        reason: args.reason,
        ok: result.ok
      });
      await saveRuntimeState(config.runtimeFile, runtimeState);
      if (!result.ok) {
        return toTextResult(`Revoke failed: ${result.error || "unknown error"}`);
      }
      const cascadedNote = result.cascadedRevocations?.length
        ? ` (${result.cascadedRevocations.length} descendants cascaded)`
        : "";
      return toTextResult(
        `Token revoked. trustId=${result.trustId || "n/a"}${cascadedNote}`,
        { trustId: result.trustId, cascaded: result.cascadedRevocations || [] }
      );
    }
  );

  server.registerTool(
    "trust_reanchor",
    {
      title: "Re-anchor intent plan (Trust Update)",
      description:
        "Sign a delta δ(h_P → h'_P) for an updated plan, preserving the " +
        "tamper-evident lineage in the IAP audit log. Re-mints the working " +
        "token so subsequent tool calls succeed.",
      inputSchema: {
        updatedPlan: INTENT_PLAN_ZOD.describe("The revised plan structure"),
        reason: z
          .string()
          .optional()
          .describe("Why the plan changed — surfaces in the audit timeline")
      }
    },
    async (args) => {
      const parsed = INTENT_PLAN_ZOD.safeParse(args.updatedPlan);
      if (!parsed.success) {
        return toTextResult(`Plan rejected: ${parsed.error.message}`);
      }
      const updatedPlan = normalizeIntentPlan(parsed.data);
      const { config, runtimeState, sessionId, session } = await resolveActiveSession();
      if (!session) {
        return toTextResult("No active session — nothing to reanchor.");
      }
      const intentToken = parseToken(session.intentTokenRaw);
      if (!intentToken) {
        return toTextResult("No intent token in session state.");
      }
      const result = await reanchorViaSdk({
        getClient: getSdkClient,
        config,
        intentToken,
        updatedPlan,
        reason: args.reason || "armorclaude:operator-reanchor"
      });
      appendTrustOp(runtimeState, sessionId, {
        operation: "ReAnchor",
        trustId: result.trustId,
        fromHash: result.fromHash,
        toHash: result.toHash,
        reason: args.reason,
        ok: result.ok
      });
      await saveRuntimeState(config.runtimeFile, runtimeState);
      if (!result.ok) {
        return toTextResult(`Reanchor failed: ${result.error || "unknown error"}`);
      }
      return toTextResult(
        `ReAnchor recorded. trustId=${result.trustId || "n/a"} delta(${(result.fromHash || "").slice(0, 12)} → ${(result.toHash || "").slice(0, 12)})`,
        { trustId: result.trustId, fromHash: result.fromHash, toHash: result.toHash }
      );
    }
  );

  server.registerTool(
    "trust_delegate",
    {
      title: "Delegate subtree of plan (Trust Update)",
      description:
        "Issue a subtree-bounded child token plus a Merkle inclusion proof. " +
        "The sub-agent receives authority confined to the named subtree path.",
      inputSchema: {
        delegatePublicKey: z.string().min(1).describe("Public key of the sub-agent that will hold the child token"),
        subtreePath: z.string().min(1).describe("Plan subtree this delegation covers, e.g. /steps/[1]"),
        validitySeconds: z.number().int().positive().optional().describe("Override the default validity"),
        targetAgent: z.string().optional().describe("Human-readable label for the sub-agent")
      }
    },
    async (args) => {
      const { config, runtimeState, sessionId, session } = await resolveActiveSession();
      if (!session) {
        return toTextResult("No active session — nothing to delegate.");
      }
      const intentToken = parseToken(session.intentTokenRaw);
      if (!intentToken) {
        return toTextResult("No intent token in session state.");
      }
      const result = await delegateSubtreeViaSdk({
        getClient: getSdkClient,
        config,
        intentToken,
        opts: {
          delegatePublicKey: args.delegatePublicKey,
          subtreePath: args.subtreePath,
          validitySeconds: args.validitySeconds,
          targetAgent: args.targetAgent
        }
      });
      appendTrustOp(runtimeState, sessionId, {
        operation: "Delegate",
        trustId: result.trustId,
        reason: `delegate to ${args.targetAgent || args.delegatePublicKey.slice(0, 16)}…`,
        ok: result.ok
      });
      await saveRuntimeState(config.runtimeFile, runtimeState);
      if (!result.ok) {
        return toTextResult(`Delegate failed: ${result.error || "unknown error"}`);
      }
      return toTextResult(
        `Delegation issued. trustId=${result.trustId || "n/a"} subtreePath=${args.subtreePath} (delegationId=${result.delegationId || "n/a"})`,
        {
          trustId: result.trustId,
          delegationId: result.delegationId,
          subtreeRoot: result.subtreeRoot,
          inclusionProofLength: Array.isArray(result.inclusionProof) ? result.inclusionProof.length : 0
        }
      );
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[armorclaude-policy] ${message}\n`);
  process.exitCode = 1;
});
