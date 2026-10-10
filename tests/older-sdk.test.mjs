import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers/login-profile.mjs";
import { writeJson } from "../scripts/lib/fs-store.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEWER_EXPORTS = [
  "MAX_BATCH_BYTES",
  "MAX_BATCH_ENTRIES",
  "MAX_BATCH_SNAPSHOTS",
  "snapshotSessionUsage",
];

async function pluginWithOlderSdk() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ac-older-sdk-"));
  await cp(path.join(repoRoot, "scripts"), path.join(root, "scripts"), { recursive: true });
  await cp(path.join(repoRoot, "package.json"), path.join(root, "package.json"));
  const modules = path.join(repoRoot, "node_modules");
  await mkdir(path.join(root, "node_modules", "@armoriq", "sdk-dev"), { recursive: true });
  for (const name of await readdir(modules)) {
    if (name === "@armoriq") continue;
    await symlink(path.join(modules, name), path.join(root, "node_modules", name));
  }
  const realSdk = path.join(modules, "@armoriq", "sdk-dev");
  const pkg = JSON.parse(await readFile(path.join(realSdk, "package.json"), "utf8"));
  const stub = path.join(root, "node_modules", "@armoriq", "sdk-dev");
  await writeFile(path.join(stub, "package.json"), JSON.stringify({ ...pkg, main: "older.cjs" }));
  await writeFile(
    path.join(stub, "older.cjs"),
    `const sdk = { ...require(${JSON.stringify(path.join(realSdk, pkg.main))}) };\n` +
      `for (const name of ${JSON.stringify(NEWER_EXPORTS)}) delete sdk[name];\n` +
      "module.exports = sdk;\n"
  );
  return root;
}

async function forbidWebFetch(dataDir) {
  await writeJson(path.join(dataDir, "policy.json"), {
    version: 1,
    updatedAt: new Date().toISOString(),
    policy: {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "enforcing", description: "" },
      defaults: { decision: "allow", conflictResolution: "deny_overrides" },
      statements: [
        {
          id: "forbid-webfetch",
          effect: "forbid",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", in: ["WebFetch"] },
          resource: { type: "workspace", scope: "current" },
          conditions: [],
        },
      ],
    },
    history: [],
  });
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDaemon(dataDir) {
  const pid = Number(await readFile(path.join(dataDir, "daemon.pid"), "utf8").catch(() => ""));
  if (!pid || !isRunning(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && isRunning(pid); i++) await new Promise((r) => setTimeout(r, 50));
}

test("PreToolUse still denies when the installed SDK lacks the batch exports", async (t) => {
  const root = await pluginWithOlderSdk();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ac-older-sdk-data-"));
  t.after(() => stopDaemon(dataDir));
  await forbidWebFetch(dataDir);
  const child = spawn(process.execPath, [path.join(root, "scripts", "hook-router.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: tempHome(),
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
      ARMORCLAUDE_DATA_DIR: dataDir,
      ARMORIQ_ENV: "local",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "older-sdk",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com" },
    })
  );
  const code = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).hookSpecificOutput?.permissionDecision, "deny");
});
