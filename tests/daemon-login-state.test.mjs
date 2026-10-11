import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { savePolicyState } from "../scripts/lib/policy.mjs";
import { waitFor } from "./helpers/hook-session.mjs";
import { STAGING, tempHome, writeLoginProfiles } from "./helpers/login-profile.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookRouter = path.join(repoRoot, "scripts", "hook-router.mjs");
const noNetwork = path.join(repoRoot, "tests", "setup", "no-network.mjs");

function pluginEnv(home, dataDir) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    NODE_OPTIONS: `--import ${noNetwork}`,
    CLAUDE_PLUGIN_DATA: dataDir,
    ARMORCLAUDE_RUNTIME_FILE: path.join(dataDir, "runtime.json"),
    ARMORCLAUDE_POLICY_FILE: path.join(dataDir, "policy.json"),
    ARMORCLAUDE_DEBUG: "true",
    ARMORIQ_ENV: "staging",
  };
}

async function runHook(env, input) {
  const { stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookRouter], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("exit", () => resolve({ stdout: out, stderr: err }));
    child.stdin.end(JSON.stringify(input));
  });
  assert.match(stderr, new RegExp(`daemon dispatch event=${input.hook_event_name}`), stderr);
  const lines = stdout.trim().split("\n").filter(Boolean);
  return lines.length ? JSON.parse(lines.at(-1)) : null;
}

const sessionStart = (env, sessionId) =>
  runHook(env, { session_id: sessionId, hook_event_name: "SessionStart" }).then(
    (out) => out?.hookSpecificOutput?.additionalContext ?? ""
  );

const preToolUse = (env, sessionId) =>
  runHook(env, {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "toolu_1",
  }).then((out) => out?.hookSpecificOutput?.permissionDecision ?? "allow");

const daemonPid = (dataDir) => Number(readFileSync(path.join(dataDir, "daemon.pid"), "utf8"));

async function stopDaemon(dataDir) {
  if (!existsSync(path.join(dataDir, "daemon.pid"))) return;
  const pid = daemonPid(dataDir);
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the daemon to exit");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function pluginData() {
  const dataDir = tempHome();
  await savePolicyState(path.join(dataDir, "policy.json"), {
    version: 1,
    policy: {
      schemaVersion: "armor.policy.v1",
      kind: "PolicyProfile",
      metadata: { name: "confirmed", description: "" },
      defaults: { decision: "allow", conflictResolution: "deny_overrides" },
      statements: [
        {
          id: "hold-webfetch",
          effect: "require_approval",
          principal: { type: "agent", id: "claude-code" },
          action: { type: "tool", eq: "WebFetch" },
          resource: { type: "workspace", scope: "current" },
          conditions: [],
        },
      ],
    },
  });
  return dataDir;
}

const LOGIN = { backend: STAGING, apiKey: "ak_test_after_start", userId: "user-after-start" };

test("a login after the daemon started enforces on the next session", async () => {
  const home = tempHome();
  const dataDir = await pluginData();
  const env = pluginEnv(home, dataDir);
  try {
    assert.match(await sessionStart(env, "before-login"), /NOT connected/);
    const pid = daemonPid(dataDir);

    writeLoginProfiles(home, [LOGIN]);

    const banner = await sessionStart(env, "after-login");
    assert.doesNotMatch(banner, /NOT connected/, banner);
    assert.match(banner, /ENFORCING, intent=required/, banner);
    assert.equal(await preToolUse(env, "after-login"), "deny");
    assert.equal(daemonPid(dataDir), pid);
  } finally {
    await stopDaemon(dataDir);
  }
});

test("a login after the daemon started puts the new user on audit rows", async () => {
  const home = tempHome();
  const dataDir = tempHome();
  const env = pluginEnv(home, dataDir);
  try {
    await sessionStart(env, "before-login");
    writeLoginProfiles(home, [LOGIN]);

    await runHook(env, {
      session_id: "after-login",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { stdout: "" },
      tool_use_id: "toolu_1",
    });

    const wal = path.join(dataDir, "audit", "current.jsonl");
    await waitFor(
      () => existsSync(wal) && readFileSync(wal, "utf8").endsWith("\n"),
      5_000,
      "the audit row"
    );
    const rows = readFileSync(wal, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.map((r) => r.user_id),
      [LOGIN.userId]
    );
  } finally {
    await stopDaemon(dataDir);
  }
});

test("a logout after the daemon started stops enforcing on the next session", async () => {
  const home = writeLoginProfiles(tempHome(), [LOGIN]);
  const dataDir = await pluginData();
  const env = pluginEnv(home, dataDir);
  try {
    assert.match(await sessionStart(env, "before-logout"), /ENFORCING, intent=required/);
    const pid = daemonPid(dataDir);

    rmSync(path.join(home, ".armoriq", "credentials.json"));

    assert.match(await sessionStart(env, "after-logout"), /NOT connected/);
    assert.equal(await preToolUse(env, "after-logout"), "allow");
    assert.equal(daemonPid(dataDir), pid);
  } finally {
    await stopDaemon(dataDir);
  }
});
