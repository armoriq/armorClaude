import { randomUUID } from "node:crypto";
import { normalizeToolName, sha256Hex } from "./common.mjs";
import { createAuditWal, loginTag, recordCaptureFailure } from "./audit-wal.mjs";
import { backendUnreachable } from "./backend-posture.mjs";
import { appendRunTool, loadRuntimeState, loadRunState, updateRunState } from "./runtime-state.mjs";

export async function reportRunCaptureFailure(config) {
  process.stderr.write("[armorclaude] run bookkeeping could not be stored.\n");
  try {
    await recordCaptureFailure(config.dataDir, "internal_error");
  } catch {
    // A reporting storage failure must not replace the hook decision or registration reply.
  }
}

// conmap-auto publishes this contract in docs/contracts/runs-v1.json, also mirrored by ArmorCodex.
export const RUNS_CONTRACT = Object.freeze({
  endReasons: ["stop", "next_prompt", "session_end", "recovered"],
  noPlanReasons: [
    "monitor_mode",
    "no_tool_use",
    "read_only",
    "backend_unreachable",
    "request_failed",
    "plan_rejected",
    "not_registered",
  ],
  limits: {
    maxBatchReports: 200,
    maxIdChars: 128,
    maxPlanIds: 20,
    maxBatchBytes: 8388608,
    maxInteger: 2147483647,
  },
  capability: {
    normalization: "Trim and lowercase the host tool name.",
    sources: [
      "scripts/lib/common.mjs",
      "scripts/lib/backend-posture.mjs",
      "scripts/lib/engine.mjs:handlePreToolUse",
    ],
    rules: [
      {
        patterns: [
          "^(?:mcp__armorclaude-policy__|mcp__plugin_armorclaude_armorclaude-policy__)?(?:register_intent_plan|policy_read|trust_revoke|trust_reanchor|trust_delegate)$",
        ],
        gated: false,
        counted: false,
      },
      {
        patterns: ["^skill$"],
        gated: false,
        counted: true,
        when: { managementSkill: "armor or armorclaude:armor or any skill ending in :armor" },
      },
      {
        patterns: [
          "^(?:toolsearch|todowrite|listmcpresourcestool|readmcpresourcetool|exitplanmode)$",
        ],
        gated: false,
        counted: true,
      },
      {
        patterns: ["^(?:read|grep|glob|websearch|webfetch)$"],
        gated: true,
        counted: true,
        when: { policyV2Action: "hold" },
      },
      { patterns: ["^(?:read|grep|glob|websearch|webfetch)$"], gated: false, counted: true },
      { patterns: ["^.*$"], gated: true, counted: true },
    ],
    notes: [
      "Backend capability labels also call ls and notebookread read, but those names do not bypass the intent gate.",
    ],
  },
  hooks: {
    start: ["UserPromptSubmit"],
    end: ["Stop"],
    nextPrompt: ["UserPromptSubmit"],
    sessionEnd: ["SessionEnd"],
    cancel: [],
    error: [],
    recovery: ["SessionStart"],
    toolAttempt: ["PreToolUse"],
    toolError: ["PostToolUseFailure"],
    notes: [
      "No separate cancel or turn error hook is registered. SessionEnd or the next prompt or plugin start closes an abandoned run. UserPromptExpansion is not a second run.",
    ],
  },
});

export function classifyRunTool(name, input, policyV2Action) {
  const normalized = normalizeToolName(name);
  const skill = String(input?.skill ?? input?.name ?? "")
    .trim()
    .toLowerCase();
  return RUNS_CONTRACT.capability.rules.find(
    (rule) =>
      rule.patterns.some((pattern) => new RegExp(pattern).test(normalized)) &&
      (!rule.when?.managementSkill || skill === "armor" || skill.endsWith(":armor")) &&
      (!rule.when?.policyV2Action || rule.when.policyV2Action === policyV2Action)
  );
}

const root = (input) => !input.agent_id && !input.parent_session_id && !input.is_subagent;
const timestamp = (now) => new Date(now).toISOString();

function report(run) {
  return {
    run_id: run.run_id,
    report_seq: run.report_seq,
    session_id: run.session_id,
    started_at: run.started_at,
    tool_calls: run.tool_calls,
    gated_tool_calls: run.gated_tool_calls,
    plan_ids: run.plan_ids.slice(0, RUNS_CONTRACT.limits.maxPlanIds),
  };
}

function noPlanReason(run) {
  if (run.plan_ids.length) return null;
  const attempts = Object.values(run.registrations);
  const facts = {
    monitor_mode: run.monitor && !run.enforcement_needed,
    no_tool_use: run.tool_calls === 0,
    read_only: run.gated_tool_calls === 0,
    backend_unreachable: run.backend_unreachable,
    request_failed: attempts.length > 0 && attempts.every(({ outcome }) => outcome === "failed"),
    plan_rejected: attempts.some(({ outcome }) => outcome === "rejected"),
    not_registered: run.gated_tool_calls > 0,
  };
  return RUNS_CONTRACT.noPlanReasons.find((reason) => facts[reason]);
}

function finalize(run) {
  if (
    !run.close_requested ||
    run.ended_at ||
    Object.values(run.registrations).some(({ outcome }) => outcome === "pending")
  )
    return;
  Object.assign(run, run.close_requested, { report_seq: run.report_seq + 1 });
  const final = { ...report(run), ended_at: run.ended_at, end_reason: run.end_reason };
  const reason = noPlanReason(run);
  if (reason) final.no_plan_reason = reason;
  if (run.login) run.reports.push(final);
}

export function closeRun(state, runId, reason, now = Date.now()) {
  const run = state.runs?.[runId];
  if (!run || run.ended_at) return;
  if (!RUNS_CONTRACT.endReasons.includes(reason)) throw new Error("Invalid run end reason");
  for (const attempt of Object.values(run.registrations)) {
    if (
      attempt.outcome === "pending" &&
      (!alive(attempt.pid) ||
        now > (attempt.deadlineAt ?? Date.parse(run.started_at) + 40_000) + 60_000)
    )
      attempt.outcome = "failed";
  }
  run.close_requested ??= {
    ended_at: timestamp(Math.max(now, Date.parse(run.started_at))),
    end_reason: reason,
  };
  finalize(run);
}

export function openRun(state, sessionId, config, now = Date.now()) {
  if (!config.runReportingEnabled) return;
  const session = state.sessions[sessionId];
  const tag =
    config.apiKey && !config.signedOut ? loginTag(config.backendEndpoint, config.apiKey) : null;
  const run = {
    run_id: session.promptId,
    session_id: sessionId,
    started_at: timestamp(now),
    report_seq: 1,
    login: tag ? { backend: config.backendEndpoint, keyId: tag } : null,
    monitor: config.mode === "monitor",
    enforcement_needed: false,
    tool_calls: 0,
    gated_tool_calls: 0,
    plan_ids: [],
    tools: {},
    registrations: {},
    reports: [],
  };
  if (run.login) run.reports.push(report(run));
  (state.runs ??= {})[run.run_id] = run;
}

export async function recordRunTool(input, config, runId, verdict) {
  if (!config.runReportingEnabled || !root(input) || !runId) return;
  const capability = classifyRunTool(input.tool_name, input.tool_input, verdict?.action);
  if (!capability?.counted) return;
  const id = input.tool_use_id || input.armorAudit?.decisionId || randomUUID();
  try {
    await appendRunTool(config, {
      runId,
      id,
      gated: capability.gated,
      enforcement_needed:
        capability.gated && config.mode !== "monitor" && config.intentRequired !== false,
      monitor: config.mode === "monitor",
      backend_unreachable: backendUnreachable(config) || verdict?.code === "backend_unreachable",
    });
  } catch {
    await reportRunCaptureFailure(config);
  }
}

export function applyRunTool(state, event) {
  const run = state.runs?.[event.runId];
  if (!run || run.close_requested || run.ended_at) return false;
  let changed = false;
  if (!run.tools[event.id]) {
    run.tools[event.id] = { gated: false };
    run.tool_calls = Math.min(RUNS_CONTRACT.limits.maxInteger, run.tool_calls + 1);
    changed = true;
  }
  if (event.gated && !run.tools[event.id].gated) {
    run.tools[event.id].gated = true;
    run.gated_tool_calls = Math.min(run.tool_calls, run.gated_tool_calls + 1);
    changed = true;
  }
  for (const fact of ["enforcement_needed", "monitor", "backend_unreachable"]) {
    if (event[fact] && !run[fact]) {
      run[fact] = true;
      changed = true;
    }
  }
  return changed;
}

export function recordRunRegistration(state, descriptor, outcome, planId) {
  const run = state.runs?.[descriptor.promptId];
  if (!run || run.ended_at || descriptor.headers?.["X-ArmorIQ-Plan-Kind"] === "refresh") return;
  const prior = run.registrations[descriptor.key];
  if (prior?.outcome === "confirmed") return;
  run.registrations[descriptor.key] = {
    outcome,
    pid: descriptor.pid ?? process.pid,
    ...(descriptor.deadlineAt ? { deadlineAt: descriptor.deadlineAt } : {}),
  };
  if (outcome === "confirmed" && planId && !run.plan_ids.includes(planId))
    run.plan_ids.push(planId);
  if (["network", "timeout"].includes(descriptor.lastReasonCode)) run.backend_unreachable = true;
  finalize(run);
}

export async function recordLocalRunRejection(config, key, runId) {
  if (!config.runReportingEnabled || !runId) return;
  await updateRunState(config, (state) => {
    recordRunRegistration(state, { promptId: runId, key: `local:${sha256Hex(key)}` }, "rejected");
  });
}

export async function storeRunRegistration(config, descriptor, outcome, planId) {
  await updateRunState(config, (state) =>
    recordRunRegistration(state, descriptor, outcome, planId)
  );
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export async function recoverRuns(input, config) {
  if (!root(input) || !config.runReportingEnabled) return;
  let runtime;
  try {
    runtime = await loadRuntimeState(config.runtimeFile);
  } catch {
    await reportRunCaptureFailure(config);
    return;
  }
  await updateRunState(config, (state) => {
    for (const run of Object.values(state.runs ?? {})) {
      if (run.ended_at) continue;
      const session = runtime.sessions[run.session_id];
      if (run.session_id === input.session_id && input.source === "compact") continue;
      if (
        run.session_id !== input.session_id &&
        (alive(session?.claudeProcessId) ||
          (!session?.claudeProcessId &&
            Date.now() - (session?.lastActivityAt ?? Date.parse(run.started_at)) < 30 * 60_000))
      )
        continue;
      for (const attempt of Object.values(run.registrations)) {
        if (attempt.outcome === "pending" && !alive(attempt.pid)) attempt.outcome = "failed";
      }
      closeRun(state, run.run_id, "recovered");
    }
  });
}

export async function flushRunReports(config) {
  if (!config.runReportingEnabled) return;
  await updateRunState(config, (state) => {
    for (const run of Object.values(state.runs ?? {})) {
      if (run.close_requested && !run.ended_at)
        closeRun(state, run.run_id, run.close_requested.end_reason);
    }
  });
  let state;
  try {
    state = await loadRunState(config);
  } catch {
    await reportRunCaptureFailure(config);
    return;
  }
  for (const run of Object.values(state.runs ?? {})) {
    try {
      if (!run.login) {
        if (run.ended_at)
          await updateRunState(config, (current) => {
            delete current.runs[run.run_id];
          });
        continue;
      }
      const wal = createAuditWal({
        dataDir: config.dataDir,
        login: run.login.keyId,
        binding: run.login,
        stream: "runs",
      });
      for (const pending of run.reports) {
        // Keep the report receipt until the outbox commits, so a crash can only replay the same transport id.
        await wal.appendLine(pending);
        await updateRunState(config, (current) => {
          const saved = current.runs?.[run.run_id];
          if (saved) {
            saved.reports = saved.reports.filter(
              ({ report_seq }) => report_seq !== pending.report_seq
            );
            if (saved.ended_at && !saved.reports.length) delete current.runs[run.run_id];
          }
        });
      }
    } catch {
      await reportRunCaptureFailure(config);
    }
  }
}
