import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./helpers/hook-session.mjs";
import { tempHome, withHome, writeLoginProfiles } from "./helpers/login-profile.mjs";
import {
  auditLoginConfig,
  auditStatus,
  createAuditWal,
  loginTag,
} from "../scripts/lib/audit-wal.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookRouter = path.join(repoRoot, "scripts", "hook-router.mjs");
const noNetwork = path.join(repoRoot, "tests", "setup", "no-network.mjs");
const A = { apiKey: "ak_test_login_a_000000000000", userId: "user-a" };
const B = { apiKey: "ak_test_login_b_000000000000", userId: "user-b" };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function startBackend(t, { refuse = new Set(), gate } = {}) {
  const shipped = [];
  const health = [];
  const entered = deferred();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const key = req.headers["x-api-key"].split(",")[0].trim();
    if (req.url === "/iap/client-events") {
      if (refuse.has(key)) return res.writeHead(401).end("{}");
      const { events } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      health.push(...events.map((event) => [key, event]));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          results: events.map(({ event_id }) => ({ event_id, outcome: "duplicate" })),
        })
      );
    }
    if (req.url !== "/iap/audit/batch") return res.writeHead(404).end("{}");
    entered.resolve();
    if (refuse.has(key)) return res.writeHead(401).end("{}");
    if (gate) await gate.promise;
    const { rows } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    shipped.push(...rows.map((row) => [key, row]));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ written: rows.length, failures: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    gate?.resolve();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, shipped, health, refuse, entered };
}

function plugin(t) {
  const home = tempHome();
  const dataDir = tempHome();
  let daemon;
  const envFor = (backend) => ({
    PATH: process.env.PATH,
    HOME: home,
    NODE_OPTIONS: `--import ${noNetwork}`,
    CLAUDE_PLUGIN_DATA: dataDir,
    ARMORIQ_ENV: "local",
    ARMORIQ_BACKEND_URL: backend.url,
    ARMORIQ_CSRG_URL: backend.url,
  });
  async function start(backend) {
    if (daemon) return;
    daemon = spawn(process.execPath, [path.join(repoRoot, "scripts", "daemon.mjs")], {
      env: envFor(backend),
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise((resolve, reject) => {
      let stderr = "";
      daemon.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.includes("listening on")) resolve();
      });
      daemon.once("error", reject);
      daemon.once("exit", () => reject(new Error("daemon exited before listening")));
    });
  }
  t.after(async () => {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, "exit");
      daemon.kill("SIGTERM");
      await exited;
    }
    await Promise.all([home, dataDir].map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const login = (backend, who) => writeLoginProfiles(home, [{ backend: backend.url, ...who }]);
  async function hook(backend, input) {
    await start(backend);
    const child = spawn(process.execPath, [hookRouter], {
      env: envFor(backend),
      stdio: ["pipe", "ignore", "ignore"],
    });
    const exited = once(child, "exit");
    child.stdin.end(JSON.stringify(input));
    const [code] = await exited;
    assert.equal(code, 0);
  }
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
  const end = (backend, sessionId) =>
    hook(backend, {
      session_id: sessionId,
      hook_event_name: "SessionEnd",
      reason: "prompt_input_exit",
    });
  return { dataDir, login, bash, stop, end };
}

const owners = (backend) => backend.shipped.map(([key, row]) => [row.user_id, key]).sort();

// regression: #0010
test("delivery resolves the exact saved credential and never a cached replacement", async (t) => {
  const home = tempHome();
  const dataDir = tempHome();
  t.after(() =>
    Promise.all([home, dataDir].map((dir) => rm(dir, { recursive: true, force: true })))
  );
  const backend = "https://a.invalid";
  const tag = loginTag(backend, A.apiKey);
  const binding = { backend, keyId: tag };
  const wal = createAuditWal({ dataDir, login: tag, binding });
  const client_row_id = randomUUID();
  await wal.appendLine({ client_row_id, tool: "Read" });
  const resolve = (value) => (withHome(home, () => auditLoginConfig(value)) ? value : null);
  writeLoginProfiles(home, [{ backend, ...A }]);
  assert.ok(resolve(binding));
  assert.equal(
    withHome(home, () =>
      auditLoginConfig(binding, { signedOut: true, backendEndpoint: backend, apiKey: "" })
    ),
    null
  );
  writeLoginProfiles(home, [
    { backend, ...B },
    { backend: "https://b.invalid", ...A },
  ]);
  assert.equal(resolve(binding), null);
  await wal.drain(() => assert.fail("used a replacement credential"), { resolveLogin: resolve });
  assert.equal((await auditStatus(dataDir, resolve)).undeliverable, 1);
  writeLoginProfiles(home, [{ backend, ...A }]);
  await wal.drain(
    async ({ login, rows }) => {
      assert.deepEqual(login, binding);
      assert.deepEqual(rows, [{ client_row_id, tool: "Read" }]);
      return { status: 200, body: { failures: [] } };
    },
    { resolveLogin: resolve }
  );
  assert.deepEqual(await wal.readPending(), []);
  assert.ok(!readFileSync(wal._paths.offsetPath, "utf8").includes(A.apiKey));
});

test("the daemon adopts a health spool on disk and sends its events only with the original login", async (t) => {
  const backend = await startBackend(t);
  const { dataDir, login, stop } = plugin(t);
  const tag = loginTag(backend.url, A.apiKey);
  const health = createAuditWal({
    dataDir,
    login: tag,
    binding: { backend: backend.url, keyId: tag },
    stream: "health",
  });
  const event = {
    event_id: randomUUID(),
    type: "plan_request_failed",
    queue: "health",
    count: 1,
    reason_code: "server_error",
    occurred_at: new Date().toISOString(),
  };
  await health.appendLine(event);
  login(backend, B);
  await stop(backend, "session-b");
  assert.deepEqual(backend.health, []);
  assert.equal((await health.readPending()).length, 1);
  login(backend, A);
  await stop(backend, "session-a");
  await waitFor(() => backend.health.length === 1, 15_000, "the adopted health event");
  assert.deepEqual(backend.health, [[A.apiKey, event]]);
  assert.deepEqual(await health.readPending(), []);
});

test("each audit row ships with the key of the login that wrote it, across a login switch (#361)", async (t) => {
  const backend = await startBackend(t);
  const { dataDir, login, bash, stop } = plugin(t);
  login(backend, A);
  await bash(backend, "session-a");
  login(backend, B);
  await bash(backend, "session-b");
  await stop(backend, "session-b");
  await waitFor(() => backend.shipped.length === 1, 15_000, "the row of login B");
  assert.deepEqual(owners(backend), [[B.userId, B.apiKey]]);
  assert.equal((await auditStatus(dataDir)).undeliverable, 1);
  login(backend, A);
  await stop(backend, "session-a");
  await waitFor(() => backend.shipped.length === 2, 15_000, "the row of login A");
  assert.deepEqual(owners(backend), [
    [A.userId, A.apiKey],
    [B.userId, B.apiKey],
  ]);
});

test("a login whose uploads fail neither blocks another login nor loses its own rows (#361)", async (t) => {
  const backend = await startBackend(t, { refuse: new Set([A.apiKey]) });
  const { dataDir, login, bash, stop } = plugin(t);
  login(backend, A);
  await bash(backend, "session-a");
  await stop(backend, "session-a");
  login(backend, B);
  await bash(backend, "session-b");
  await stop(backend, "session-b");
  await waitFor(() => backend.shipped.length === 1, 15_000, "the row of login B");
  assert.deepEqual(owners(backend), [[B.userId, B.apiKey]]);
  backend.refuse.clear();
  await stop(backend, "session-b");
  assert.equal(backend.shipped.length, 1);
  const wal = createAuditWal({ dataDir, login: loginTag(backend.url, A.apiKey) });
  assert.equal((await wal.readPending())[0].attempts, 0);
  login(backend, { ...A, loggedInAt: "2026-11-15T12:00:00.000Z" });
  await stop(backend, "session-a");
  await waitFor(() => backend.shipped.length === 2, 15_000, "the restored row of login A");
  assert.deepEqual(owners(backend), [
    [A.userId, A.apiKey],
    [B.userId, B.apiKey],
  ]);
});

test("a login first seen while a slow flush runs still ships its rows (#361)", async (t) => {
  const gate = deferred();
  const slow = await startBackend(t, { gate });
  const fast = await startBackend(t);
  const { login, bash, stop } = plugin(t);
  login(slow, A);
  login(fast, B);
  await bash(slow, "session-slow");
  const slowStop = stop(slow, "session-slow");
  await slow.entered.promise;
  try {
    await bash(fast, "session-fast");
    const fastStop = stop(fast, "session-fast");
    await fast.entered.promise;
    gate.resolve();
    await Promise.all([fastStop, slowStop]);
  } finally {
    gate.resolve();
  }
  assert.deepEqual(owners(fast), [[B.userId, B.apiKey]]);
  assert.deepEqual(owners(slow), [[A.userId, A.apiKey]]);
});

test("the old shared WAL remains visible as undeliverable and is never shipped (#361)", async (t) => {
  const backend = await startBackend(t);
  const { dataDir, login, bash, stop } = plugin(t);
  const auditDir = path.join(dataDir, "audit");
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const file = path.join(auditDir, "current.jsonl");
  const original =
    JSON.stringify({ tool: "Untagged", user_id: "user-old", _seq: 1, _enqueuedAt: 1 }) + "\n";
  writeFileSync(file, original, { mode: 0o600 });
  login(backend, A);
  await bash(backend, "session-a");
  await stop(backend, "session-a");
  await waitFor(() => backend.shipped.length === 1, 15_000, "the tagged row");
  assert.deepEqual(
    backend.shipped.map(([key, row]) => [row.tool, key]),
    [["Bash", A.apiKey]]
  );
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(file, "utf8"), original);
  const status = await handleArmorPolicyCommand("/armor status", { dataDir });
  assert.match(status, /Undeliverable: 1/);
  assert.match(status, /Dead letters: 0/);
  assert.match(status, /Capture failures: 0/);
});

// regression: #521
test("Stop and SessionEnd return before a slow upload lands, and the row still ships", async (t) => {
  const gate = deferred();
  const slow = await startBackend(t, { gate });
  const { login, bash, stop, end } = plugin(t);

  login(slow, A);
  await bash(slow, "session-exit");
  await stop(slow, "session-exit");
  await end(slow, "session-exit");
  assert.equal(slow.shipped.length, 0);

  gate.resolve();
  await waitFor(() => slow.shipped.length === 1, 15_000, "the row after the slow upload");
  assert.deepEqual(owners(slow), [[A.userId, A.apiKey]]);
});
