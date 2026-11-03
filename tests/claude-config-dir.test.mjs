import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeConfigDir } from "../scripts/lib/claude-paths.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { projectsDir } from "../scripts/lib/live-usage.mjs";
import { resolvePlanFilePath } from "../scripts/lib/planner.mjs";
import {
  assistant,
  backend,
  env,
  home,
  hookRouter,
  isoAgo,
  quiet,
  run,
  sessionBatches,
  stopDaemon,
  until,
} from "./helpers/live-usage.mjs";

const worker = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "usage-worker.mjs"
);

function withConfigDir(value, fn) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  if (value === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

test("Claude Code paths follow CLAUDE_CONFIG_DIR and fall back to ~/.claude", () => {
  const custom = path.join(homedir(), ".claude-second");
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: custom }), custom);
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: `${custom}/` }), custom);
  for (const unset of [{}, { CLAUDE_CONFIG_DIR: "  " }])
    assert.equal(claudeConfigDir(unset), path.join(homedir(), ".claude"));
  assert.equal(projectsDir({ CLAUDE_CONFIG_DIR: custom }), path.join(custom, "projects"));
  assert.equal(loadConfig({ CLAUDE_CONFIG_DIR: custom }).dataDir, path.join(custom, "armorclaude"));
  assert.equal(loadConfig({}).dataDir, path.join(homedir(), ".claude", "armorclaude"));
  const input = { transcript_path: "/x/sessions/plan-name.jsonl" };
  assert.equal(
    withConfigDir(custom, () => resolvePlanFilePath(input)),
    path.join(custom, "plans", "plan-name.md")
  );
  assert.equal(
    withConfigDir(undefined, () => resolvePlanFilePath(input)),
    path.join(homedir(), ".claude", "plans", "plan-name.md")
  );
});

function writeConfigSession(configDir, sessionId, usage) {
  const dir = path.join(configDir, "projects", "-work-repo");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, JSON.stringify(assistant(sessionId, "a", isoAgo(60_000), usage)) + "\n");
  return file;
}

async function withConfigHome(fn) {
  const b = await backend();
  b.release();
  const h = home(b.url, isoAgo(3 * 3_600_000));
  const configDir = path.join(h, ".claude-second");
  try {
    await fn(b, h, configDir);
    await quiet(h);
  } finally {
    await stopDaemon(h);
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
}

for (const daemon of [false, true]) {
  const via = daemon ? "through the daemon" : "without the daemon";
  test(`a Stop uploads a transcript kept under CLAUDE_CONFIG_DIR, ${via}`, async () => {
    await withConfigHome(async (b, h, configDir) => {
      const id = randomUUID();
      const transcript = writeConfigSession(configDir, id, { input_tokens: 9, output_tokens: 2 });
      const stop = JSON.stringify({
        hook_event_name: "Stop",
        session_id: id,
        transcript_path: transcript,
      });
      await run(hookRouter, { ...env(h, b.url, daemon), CLAUDE_CONFIG_DIR: configDir }, stop);
      await until(() => sessionBatches(b, id).length > 0, "the session's batch");
      assert.equal(sessionBatches(b, id)[0].entries[0].inputTokens, 9);
    });
  });
}

test("the usage worker finds sessions kept under CLAUDE_CONFIG_DIR", async () => {
  await withConfigHome(async (b, h, configDir) => {
    const id = randomUUID();
    writeConfigSession(configDir, id, { input_tokens: 5, output_tokens: 1 });
    const result = await run(worker, { ...env(h, b.url, false), CLAUDE_CONFIG_DIR: configDir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(sessionBatches(b, id).length, 1, result.stderr);
  });
});
