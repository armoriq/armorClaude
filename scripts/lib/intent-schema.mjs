import { z } from "zod";

export const PLAN_STEP_SCHEMA = z.object({
  action: z.string().min(1).describe("Tool name (e.g. Read, Edit, Bash, mcp__server__tool)"),
  description: z.string().optional().describe("Why this step is needed"),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The tool parameters you expect to pass"),
});

export const INTENT_PLAN_ZOD = z.object({
  goal: z.string().min(1).describe("One-line summary of what the plan accomplishes"),
  steps: z
    .array(PLAN_STEP_SCHEMA)
    .min(1)
    .describe("Ordered list of tool calls the agent intends to make"),
});

export const INTENT_PLAN_FORMAT = `{
  "goal": "<one-line summary of the task>",
  "steps": [
    {
      "action": "<ToolName e.g. Read, Edit, Bash, Grep, Glob, Write, WebFetch>",
      "description": "<why this step is needed>",
      "arguments": { /* expected tool parameters, optional */ }
    }
  ]
}`;

export function normalizeIntentPlan(parsed) {
  return {
    steps: parsed.steps.map((s) => ({
      action: s.action,
      tool: s.action,
      mcp: "claude-code",
      description: s.description || "",
      arguments: s.arguments || {},
    })),
    metadata: {
      goal: parsed.goal,
      source: "claude-registered",
    },
  };
}
