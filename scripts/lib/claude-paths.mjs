import { homedir } from "node:os";
import path from "node:path";

export function claudeConfigDir(env = process.env) {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(homedir(), ".claude");
}
