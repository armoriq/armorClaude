export function denyPreTool(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export function askPreTool(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Phase 4 A3: actionable deny output.
 *
 * When a tool is blocked by drift / missing plan / missing token, return a
 * deny that *also* tells the LLM the exact JSON to call register_intent_plan
 * with. Claude reads `permissionDecisionReason` and can self-correct in 1
 * follow-up turn instead of 3 (deny → re-prompt user → re-prompt for the
 * right format → finally register).
 *
 * @param {string} reason            free-form explanation
 * @param {object} args
 * @param {string} args.toolName     the tool that was blocked (will end up in the suggested plan)
 * @param {object} [args.toolInput]  the exact arguments — will be embedded into metadata.inputs
 * @param {string} [args.goal]       inferred goal from session.lastPrompt or the tool name
 * @param {object} [args.knownPlan]  the currently-cached plan (if any) — we'll suggest extending it
 */
export function denyPreToolWithHint(reason, args = {}) {
  const { toolName = "Tool", toolInput, goal, knownPlan } = args;
  const newStep = {
    action: toolName,
    description: `Use ${toolName} to ${goal || "make progress on the user's task"}`,
  };
  if (toolInput && typeof toolInput === "object" && Object.keys(toolInput).length > 0) {
    // Don't pin params strictly — Phase 3 made metadata.inputs advisory.
    // Include them for documentation only.
    newStep.metadata = { inputs: toolInput };
  }
  let suggestedPlan;
  if (knownPlan && Array.isArray(knownPlan.steps) && knownPlan.steps.length > 0) {
    suggestedPlan = {
      goal: knownPlan.goal || goal || "extend prior plan",
      steps: [...knownPlan.steps, newStep],
    };
  } else {
    suggestedPlan = {
      goal: goal || `Run ${toolName}`,
      steps: [newStep],
    };
  }
  const hint =
    `\n\nTo unblock: call register_intent_plan with this JSON:\n` +
    "```json\n" +
    JSON.stringify(suggestedPlan, null, 2) +
    "\n```";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason + hint,
    },
  };
}

/**
 * Freemium fallback: allow the tool to proceed WITHOUT ArmorClaude enforcement,
 * surfacing a one-time upgrade nudge to the user via `systemMessage`.
 *
 * We deliberately DO NOT set `permissionDecision` — that leaves Claude Code's
 * own permission flow untouched (ArmorClaude simply steps aside / runs in
 * observe-only mode) rather than force-allowing. Used when intent-token
 * issuance fails for a *billing* reason so a free user isn't hard-blocked with
 * a cryptic error that looks like a policy denial.
 */
export function allowWithNotice(systemMessage) {
  return {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
    },
  };
}

/**
 * True when an intent-token failure is a billing/subscription gate (HTTP 402
 * from the backend quota service) rather than a real enforcement error. Matches
 * the backend messages in conmap-auto/src/billing/quota.service.ts.
 */
export function isBillingError(message) {
  return /subscription is required|active ArmorIQ Pro|billing cannot be verified|payment required|\b402\b/i.test(
    String(message || "")
  );
}

export function blockPrompt(reason) {
  return {
    decision: "block",
    reason,
  };
}

/**
 * Reply to a handled `/armor` slash command.
 *
 * Mechanically this is still a `block` decision — that's the only hook output
 * that keeps the command text away from the LLM while showing our own output.
 * Claude Code's UI prints a fixed "operation blocked by hook:" prefix for any
 * block, which reads as an error even though the command succeeded. We can't
 * suppress that prefix, but we can lead the reason with a subtle tag so the
 * message reads as a normal, handled command rather than a failure.
 */
export function armorReply(reason) {
  return blockPrompt(`(ArmorClaude — handled OK)\n${reason}`);
}

export function addPromptContext(context, hookEventName = "UserPromptSubmit") {
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: context,
    },
  };
}
