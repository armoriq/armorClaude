import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonLogPath } from "../scripts/lib/daemon-log.mjs";
import { waitFor } from "./helpers/hook-session.mjs";
import { tempHome, writeLoginProfiles } from "./helpers/login-profile.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookRouter = path.join(repoRoot, "scripts", "hook-router.mjs");
const noNetwork = path.join(repoRoot, "tests", "setup", "no-network.mjs");

const A = { apiKey: "ak_test_login_a_000000000000", userId: "user-a" };
const B = { apiKey: "ak_test_login_b_000000000000", userId: "user-b" };

async function startBackend(t, { refuse = new Set(), delayMs = 0 } = {}) {
  const shipped = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      if (req.url !== "/iap/audit/batch") return res.writeHead(404).end("{}");
      const key = req.headers["x-api-key"].split(",")[0].trim();
      if (refuse.has(key)) return res.writeHead(401).end("{}");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const { rows } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      shipped.push(...rows.map((row) => [key, row]));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ written: rows.length, failures: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return { url: `http://127.0.0.1:${server.address().port}`, shipped, refuse };
}

function plugin(t) {
  const home = tempHome();
  const dataDir = tempHome();
  t.after(async () => {
    const pidFile = path.join(dataDir, "daemon.pid");
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8"));
    process.kill(pid, "SIGTERM");
    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      10_000,
      "the daemon to exit"
    );
  });
  const login = (backend, who) => writeLoginProfiles(home, [{ backend: backend.url, ...who }]);
  const hook = (backend, input) =>
    new Promise((resolve, reject) => {
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        NODE_OPTIONS: `--import ${noNetwork}`,
        CLAUDE_PLUGIN_DATA: dataDir,
        ARMORIQ_ENV: "local",
        ARMORIQ_BACKEND_URL: backend.url,
        ARMORIQ_CSRG_URL: backend.url,
      };
      const child = spawn(process.execPath, [hookRouter], {
        env,
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("exit", resolve);
      child.stdin.end(JSON.stringify(input));
    });
  const bash = (backend, sessionId) =>
    hook(backend, {
      session_id: sessionId,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { stdout: "" },
    });
  const stop = (backend, sessionId) =>
    hook(backend, { session_id: sessionId, hook_event_name: "Stop" });
  return { dataDir, login, bash, stop };
}

const owners = (backend) => backend.shipped.map(([key, row]) => [row.user_id, key]).sort();

test("each audit row ships with the key of the login that wrote it, across a login switch (#361)", async (t) => {
  const backend = await startBackend(t);
  const { login, bash, stop } = plugin(t);

  login(backend, A);
  await bash(backend, "session-a");
  login(backend, B);
  await bash(backend, "session-b");
  await stop(backend, "session-b");

  await waitFor(() => backend.shipped.length === 2, 15_000, "two shipped rows");
  assert.deepEqual(owners(backend), [
    [A.userId, A.apiKey],
    [B.userId, B.apiKey],
  ]);
});

test("a login whose uploads fail neither blocks another login nor loses its own rows (#361)", async (t) => {
  const backend = await startBackend(t, { refuse: new Set([A.apiKey]) });
  const { login, bash, stop } = plugin(t);

  login(backend, A);
  await bash(backend, "session-a");
  login(backend, B);
  await bash(backend, "session-b");
  await stop(backend, "session-b");
  await waitFor(() => backend.shipped.length === 1, 15_000, "B's row");
  assert.deepEqual(owners(backend), [[B.userId, B.apiKey]]);

  backend.refuse.clear();
  await stop(backend, "session-b");
  await waitFor(() => backend.shipped.length === 2, 15_000, "A's row after A recovers");
  assert.deepEqual(owners(backend), [
    [A.userId, A.apiKey],
    [B.userId, B.apiKey],
  ]);
});

test("a login first seen while a slow flush runs still ships its rows (#361)", async (t) => {
  const slow = await startBackend(t, { delayMs: 3_000 });
  const fast = await startBackend(t);
  const { login, bash, stop } = plugin(t);

  login(slow, A);
  login(fast, B);
  await bash(slow, "session-slow");
  const slowStop = stop(slow, "session-slow");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await bash(fast, "session-fast");

  await waitFor(() => fast.shipped.length === 1, 15_000, "the fast backend's row");
  await slowStop;
  await waitFor(() => slow.shipped.length === 1, 15_000, "the slow backend's row");
  assert.deepEqual(owners(fast), [[B.userId, B.apiKey]]);
  assert.deepEqual(owners(slow), [[A.userId, A.apiKey]]);
});

test("the old shared WAL is deleted at start with a daemon.log line and never shipped (#361)", async (t) => {
  const backend = await startBackend(t);
  const { dataDir, login, bash, stop } = plugin(t);
  const auditDir = path.join(dataDir, "audit");
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(auditDir, "current.jsonl"),
    `${JSON.stringify({ tool: "Untagged", user_id: "user-old", _seq: 1, _enqueuedAt: 1 })}\n`,
    { mode: 0o600 }
  );

  login(backend, A);
  await bash(backend, "session-a");
  await stop(backend, "session-a");

  await waitFor(() => backend.shipped.length === 1, 15_000, "the session's row");
  assert.deepEqual(
    backend.shipped.map(([key, row]) => [row.tool, key]),
    [["Bash", A.apiKey]]
  );
  assert.equal(existsSync(path.join(auditDir, "current.jsonl")), false);
  assert.match(readFileSync(daemonLogPath(dataDir), "utf8"), /deleted audit\/current\.jsonl/);
});
