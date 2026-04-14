/**
 * Plan parsing for ArmorCowork.
 *
 * Two capture paths, one schema:
 *  1. Plan mode: parse the plan file for a fenced ```json block (preferred)
 *     or heuristic markdown extraction (fallback)
 *  2. No plan mode: Claude calls register_intent_plan MCP tool directly
 *     (handled in policy-mcp.mjs, not here)
 *
 * This module handles only PARSING — plan generation is done by Claude's own
 * LLM via the directive injected in UserPromptSubmit.
 */

import { readFile } from "node:fs/promises";
import { normalizeToolName } from "./common.mjs";

// ---------------------------------------------------------------------------
// JSON block extraction (preferred — matches the directive's format)
// ---------------------------------------------------------------------------

/**
 * Extract a fenced ```json block from markdown content.
 * The UserPromptSubmit directive tells Claude to include the plan as a
 * fenced JSON block in plan mode.
 */
export function extractPlanJsonBlock(markdown) {
  if (!markdown) return null;
  const match = markdown.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Plan file parsing (heuristic fallback)
// ---------------------------------------------------------------------------

/**
 * Parse a Claude plan markdown file into a structured plan.
 * The plan file is at ~/.claude/plans/<session-name>.md.
 */
export async function parsePlanFile(planFilePath) {
  if (!planFilePath) return null;
  let content;
  try {
    content = await readFile(planFilePath, "utf8");
  } catch {
    return null;
  }
  if (!content.trim()) return null;
  return parsePlanMarkdown(content);
}

/**
 * Heuristic: extract tool intentions from markdown content.
 * Looks for backtick-wrapped tool names and numbered/bulleted steps.
 */
export function parsePlanMarkdown(markdown) {
  const steps = [];
  const seenTools = new Set();

  // Backtick-wrapped identifiers: `Read`, `mcp__server__tool`
  const backtickPattern = /`([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*)`/g;
  for (const match of markdown.matchAll(backtickPattern)) {
    const name = match[1]?.trim();
    if (name && name.length > 1 && name.length < 80) {
      seenTools.add(normalizeToolName(name));
    }
  }

  // Numbered / bulleted steps
  const stepPattern = /^[\s]*(?:\d+[.)]\s+|[-*]\s+)(.+)/gm;
  for (const match of markdown.matchAll(stepPattern)) {
    const text = match[1]?.trim();
    if (!text || text.length < 3) continue;
    const toolRef = extractToolFromStepText(text);
    if (toolRef) {
      seenTools.add(normalizeToolName(toolRef));
      steps.push({
        action: toolRef,
        mcp: "claude-code",
        description: text,
        metadata: {}
      });
    }
  }

  // If no steps from list parsing, create steps from discovered tool names
  if (steps.length === 0) {
    for (const toolName of seenTools) {
      steps.push({
        action: toolName,
        mcp: "claude-code",
        description: `Use ${toolName}`,
        metadata: {}
      });
    }
  }

  const headingMatch = markdown.match(/^#+\s+(.+)/m);
  const goal = headingMatch ? headingMatch[1].trim() : markdown.split("\n")[0]?.trim() || "Plan";

  return {
    steps,
    metadata: { goal, source: "plan-file-heuristic" }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KNOWN_TOOLS = new Set([
  "read", "write", "edit", "bash", "glob", "grep", "agent",
  "webfetch", "websearch", "notebookedit", "askuserquestion",
  "taskcreate", "taskupdate", "skill"
]);

function extractToolFromStepText(text) {
  const backtickMatch = text.match(/`([A-Za-z][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)*)`/);
  if (backtickMatch) return backtickMatch[1];

  const mcpMatch = text.match(/\b(mcp__[a-z0-9_]+__[a-z0-9_]+)\b/i);
  if (mcpMatch) return mcpMatch[1];

  const words = text.split(/\s+/);
  const firstWord = words[0]?.toLowerCase().replace(/[^a-z]/g, "");
  if (KNOWN_TOOLS.has(firstWord)) {
    return firstWord.charAt(0).toUpperCase() + firstWord.slice(1);
  }

  return null;
}

/**
 * Resolve the plan file path for the current session.
 * Claude Code writes plans to ~/.claude/plans/<session-name>.md
 */
export function resolvePlanFilePath(input) {
  const transcriptPath =
    typeof input?.transcript_path === "string" ? input.transcript_path : "";

  const sessionMatch = transcriptPath.match(
    /sessions\/([^/]+?)(?:\.jsonl)?$/
  );
  const sessionName = sessionMatch ? sessionMatch[1] : null;

  if (sessionName) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
    return `${homeDir}/.claude/plans/${sessionName}.md`;
  }

  return null;
}
