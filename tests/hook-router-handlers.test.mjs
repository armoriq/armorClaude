import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DAEMON_VERSION } from "../scripts/lib/daemon-version.mjs";
import { installedPluginRoot } from "./helpers/hook-session.mjs";

// regression: #0013
test("bootstrap hooks and direct handlers use the same daemon installation identity", async () => {
  const root = await installedPluginRoot();
  const installed = await import(pathToFileURL(path.join(root, "scripts/lib/daemon-version.mjs")));
  assert.equal(installed.DAEMON_VERSION, DAEMON_VERSION);
});

// regression: #0010
test("the installed bootstrap hook denies invalid input without installing packages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "armor-installed-hook-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL("..", import.meta.url));
  await cp(path.join(repo, "scripts"), path.join(root, "scripts"), { recursive: true });
  await cp(path.join(repo, ".claude-plugin"), path.join(root, ".claude-plugin"), {
    recursive: true,
  });
  const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
  await writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  for (const name of Object.keys(pkg.dependencies)) {
    const target = path.join(root, "node_modules", name);
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(path.join(repo, "node_modules", name), target, "dir");
  }
  await writeFile(path.join(root, "node_modules", ".armorclaude-installed"), pkg.version);
  const manifest = JSON.parse(await readFile(path.join(repo, "hooks", "hooks.json"), "utf8"));
  const command = manifest.hooks.PreToolUse[0].hooks[0].command;
  const [, ...args] = command.replace("${CLAUDE_PLUGIN_ROOT}", root).split(" ");
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      CLAUDE_PLUGIN_DATA: path.join(root, "data"),
      ARMORIQ_ENV: "local",
      ARMORIQ_ORG_MODE: "enforce",
      ARMORIQ_BACKEND_URL: "http://127.0.0.1:1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end("not json");
  assert.equal((await exited)[0], 0, stderr);
  assert.doesNotMatch(stderr, /installing dependencies/);
  const output = JSON.parse(stdout || "null");
  assert.equal(output?.hookSpecificOutput?.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /invalid JSON/);
});
