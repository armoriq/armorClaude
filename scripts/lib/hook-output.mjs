export const DECISION_CODE = Symbol("armorclaude.decisionCode");

function preToolDecision(code, permissionDecision, permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason,
    },
    [DECISION_CODE]: code,
  };
}

export const denyPreTool = (code, reason) => preToolDecision(code, "deny", reason);

export const askPreTool = (code, reason) => preToolDecision(code, "ask", reason);

/**
 * Phase 4 A3: actionable deny output.
 *
 * When a tool is blocked by drift / missing plan / missing token, return a
 * deny that *also* tells the LLM the exact JSON to call register_intent_plan
 * with. Claude reads `permissionDecisionReason` and can self-correct in 1
 * follow-up turn instead of 3 (deny → re-prompt user → re-prompt for the
 * right format → finally register).
 *
 * @param {string} code              the rule or check that denied the call
 * @param {string} reason            free-form explanation
 * @param {object} args
 * @param {string} args.toolName     the tool that was blocked (will end up in the suggested plan)
 * @param {object} [args.toolInput]  the exact arguments — will be embedded as the step's arguments
 * @param {string} [args.goal]       inferred goal from session.lastPrompt or the tool name
 * @param {object} [args.knownPlan]  the currently-cached plan (if any) — we'll suggest extending it
 */
export function denyPreToolWithHint(code, reason, args = {}) {
  const { toolName = "Tool", toolInput, goal, knownPlan } = args;
  const newStep = {
    action: toolName,
    description: `Use ${toolName} to ${goal || "make progress on the user's task"}`,
  };
  if (toolInput && typeof toolInput === "object" && Object.keys(toolInput).length > 0) {
    newStep.arguments = toolInput;
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
  return denyPreTool(code, reason + hint);
}

/** Omitting permissionDecision defers to Claude Code's own permission prompts; setting allow would bypass them. */
export function allowWithNotice(systemMessage) {
  return {
    systemMessage,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
    },
  };
}

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

/** Only a block hides /armor text from the model; Claude Code prefixes it with "operation blocked by hook:". */
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
