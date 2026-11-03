import { homedir } from "node:os";
import path from "node:path";

// Claude Code keeps transcripts, plans, commands and plugin data under
// CLAUDE_CONFIG_DIR when it is set, and under ~/.claude otherwise.
export function claudeConfigDir(env = process.env) {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".claude");
}
