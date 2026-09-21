#!/usr/bin/env node
/**
 * Installs the global /armor slash command into ~/.claude/commands/armor.md
 * so users can type /armor yes instead of /armorclaude:armor yes.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_CMD = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "commands",
  "armor.md"
);

const GLOBAL_CMD_DIR = path.join(os.homedir(), ".claude", "commands");
const GLOBAL_CMD = path.join(GLOBAL_CMD_DIR, "armor.md");

async function install() {
  const src = await readFile(PLUGIN_CMD, "utf8");
  await mkdir(GLOBAL_CMD_DIR, { recursive: true });

  if (existsSync(GLOBAL_CMD)) {
    const existing = await readFile(GLOBAL_CMD, "utf8");
    if (existing === src) {
      console.log("ArmorClaude: /armor global command already up to date.");
      return;
    }
  }

  await writeFile(GLOBAL_CMD, src, "utf8");
  console.log(`ArmorClaude: installed /armor global command → ${GLOBAL_CMD}`);
}

install().catch((err) => {
  // Non-fatal — don't break npm install if this fails.
  console.warn(`ArmorClaude: could not install /armor command: ${err?.message ?? err}`);
});
