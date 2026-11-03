import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import armoriqSdk from "@armoriq/sdk-dev";
import {
  STAGING,
  loadConfigWithLogins,
  tempHome,
  writeLoginProfiles,
} from "./helpers/login-profile.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookRouter = path.join(repoRoot, "scripts", "hook-router.mjs");
const loginLine = (backend) =>
  `No ArmorClaude login for ${backend}. Run: armoriq-dev login --product armorclaude`;

function pluginEnv(home, dataDir, backend) {
  const target =
    backend === STAGING
      ? { ARMORIQ_ENV: "staging" }
      : { ARMORIQ_ENV: "local", ARMORIQ_BACKEND_URL: backend, ARMORIQ_CSRG_URL: backend };
  return {
    PATH: process.env.PATH,
    HOME: home,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
    CLAUDE_PLUGIN_DATA: dataDir,
    ARMORCLAUDE_RUNTIME_FILE: path.join(dataDir, "runtime.json"),
    ARMORCLAUDE_POLICY_FILE: path.join(dataDir, "policy.json"),
    ...target,
  };
}

function sessionStart(env, sessionId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookRouter], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("error", reject);
    child.on("exit", (code) => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      const output = lines.length ? JSON.parse(lines.at(-1)) : null;
      resolve({
        code,
        systemMessage: output?.systemMessage,
        context: output?.hookSpecificOutput?.additionalContext ?? "",
      });
    });
    child.stdin.end(JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart" }));
  });
}

async function stopDaemon(dataDir) {
  const pidFile = path.join(dataDir, "daemon.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
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

async function threeStarts(home, backend, daemon) {
  const dataDir = tempHome();
  if (!daemon) writeFileSync(path.join(dataDir, "profiles"), "not a directory");
  const env = pluginEnv(home, dataDir, backend);
  try {
    const runs = [];
    for (const sessionId of ["s-1", "s-1", "s-2"]) {
      const run = await sessionStart(env, sessionId);
      assert.equal(run.code, 0);
      runs.push(run);
    }
    return runs;
  } finally {
    if (daemon) await stopDaemon(dataDir);
  }
}

function loginWithoutHistory() {
  const home = tempHome();
  const name = armoriqSdk.profileName(STAGING, "armorclaude");
  const file = path.join(home, ".armoriq", "credentials.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      active: name,
      historyOrigin: "fresh",
      loginHistory: {},
      profiles: {
        [name]: {
          backend: STAGING,
          product: "armorclaude",
          apiKey: "ak_test_nohistory",
          email: "a@example.test",
          userId: "user-a",
          orgId: "org-a",
          loggedInAt: "2026-10-09T10:00:00.000Z",
          savedAt: "2026-10-09T10:00:00.000Z",
        },
      },
    }),
    { mode: 0o600 }
  );
  return home;
}

const NO_LOGIN = {
  "a login with no recorded history": loginWithoutHistory,
  "only an armorcodex login": () =>
    writeLoginProfiles(tempHome(), [
      { backend: STAGING, product: "armorcodex", apiKey: "ak_test_codexonly" },
    ]),
};

for (const [what, makeHome] of Object.entries(NO_LOGIN)) {
  for (const daemon of [false, true]) {
    const via = daemon ? "through the daemon" : "without the daemon";
    test(`${what} shows the login line once per session and stays in monitor mode, ${via}`, async () => {
      const runs = await threeStarts(makeHome(), STAGING, daemon);
      assert.deepEqual(
        runs.map((r) => r.systemMessage),
        [loginLine(STAGING), undefined, loginLine(STAGING)]
      );
      for (const r of runs) {
        assert.ok(r.context.includes("MONITOR"), r.context);
        assert.ok(r.context.includes(loginLine(STAGING)), r.context);
      }
    });
  }
}

test("a matching staging armorclaude login is connected, so the login line never applies", () => {
  const config = loadConfigWithLogins([{ backend: STAGING, apiKey: "ak_test_claude" }], {
    ARMORIQ_ENV: "staging",
  });
  assert.equal(config.unconfigured, false);
  assert.equal(config.apiKey, "ak_test_claude");
});

for (const daemon of [false, true]) {
  const via = daemon ? "through the daemon" : "without the daemon";
  test(`a matching armorclaude login shows no login line, ${via}`, async () => {
    const server = createServer((req, res) => res.writeHead(404).end());
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const backend = `http://127.0.0.1:${server.address().port}`;
    try {
      const home = writeLoginProfiles(tempHome(), [{ backend, apiKey: "ak_test_claude" }]);
      for (const r of await threeStarts(home, backend, daemon)) {
        assert.ok(!(r.systemMessage ?? "").includes("No ArmorClaude login"), r.systemMessage);
        assert.ok(!r.context.includes("No ArmorClaude login"), r.context);
      }
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
