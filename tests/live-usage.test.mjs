import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import armoriqSdk from "@armoriq/sdk-dev";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookRouter = path.join(repoRoot, "scripts", "hook-router.mjs");
const scanner = path.join(repoRoot, "scripts", "usage-sync.mjs");
const KEY = "ak_test_live_usage_0001";
const USER = `user-of-${KEY}`;
const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

function backend() {
  const batches = [];
  const singles = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = raw ? JSON.parse(raw) : {};
      const reply = (status, data) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url === "/iap/validate-key") return reply(200, { userId: USER });
      if (req.url.startsWith("/api-keys/device-history-sync"))
        return reply(200, { requestedAt: null });
      if (req.url === "/dashboard/token-usage/stream")
        return reply(200, { generation: GENERATION });
      if (req.url === "/dashboard/token-usage/batch") {
        batches.push(body);
        return reply(200, {
          results: body.snapshots.map((s) => ({
            sessionId: s.sessionId,
            usageDate: s.usageDate,
            usageHour: s.usageHour,
            status: "applied",
          })),
        });
      }
      if (req.url === "/dashboard/token-usage") {
        singles.push(body);
        await released;
        return reply(201, { ok: true, recorded: 1 });
      }
      reply(404, {});
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        batches,
        singles,
        release,
        url: `http://127.0.0.1:${server.address().port}`,
      })
    )
  );
}

const GENERATION = randomUUID();

function login(home, url, at) {
  const file = path.join(home, ".armoriq", "credentials.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const name = armoriqSdk.profileName(url, "armorclaude");
  const doc = {
    version: 2,
    active: name,
    historyOrigin: "fresh",
    loginHistory: {
      [name]: { id: randomUUID(), origin: "fresh", events: [{ sequence: 1, at, userId: USER }] },
    },
    profiles: {
      [name]: {
        backend: url,
        product: "armorclaude",
        apiKey: KEY,
        email: "dev@example.com",
        userId: USER,
        orgId: "org-1",
        loggedInAt: at,
        savedAt: at,
      },
    },
  };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

function home(url, loggedInAt) {
  const dir = path.join(tmpdir(), `live-usage-${randomUUID()}`);
  assert.ok(dir.startsWith(tmpdir()));
  mkdirSync(path.join(dir, ".claude", "projects", "-work-repo"), { recursive: true });
  login(dir, url, loggedInAt);
  return dir;
}

const projectFile = (h, sessionId) =>
  path.join(h, ".claude", "projects", "-work-repo", `${sessionId}.jsonl`);

const assistant = (sessionId, id, timestamp, usage) => ({
  type: "assistant",
  sessionId,
  cwd: "/work/repo",
  timestamp,
  requestId: `r-${id}`,
  message: { id, model: "claude-opus", usage },
});

function writeSession(h, sessionId, lines) {
  writeFileSync(projectFile(h, sessionId), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function env(h, url, daemon) {
  const dataDir = path.join(h, "data");
  mkdirSync(dataDir, { recursive: true });
  if (!daemon) writeFileSync(path.join(dataDir, "profiles"), "not a directory");
  return {
    PATH: process.env.PATH,
    HOME: h,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
    ARMORCLAUDE_DATA_DIR: dataDir,
    ARMORCLAUDE_RUNTIME_FILE: path.join(dataDir, "runtime.json"),
    ARMORCLAUDE_POLICY_FILE: path.join(dataDir, "policy.json"),
    ARMORIQ_ENV: "local",
    ARMORIQ_BACKEND_URL: url,
    ARMORIQ_CSRG_URL: url,
    ARMORIQ_DEVICE_ID_PATH: path.join(h, "device-id"),
  };
}

function run(script, environment, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: environment,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr, pid: child.pid }));
    child.stdin.end(stdin);
  });
}

const stop = (h, url, daemon, sessionId, extra = {}) =>
  run(
    hookRouter,
    { ...env(h, url, daemon), ...extra },
    JSON.stringify({
      hook_event_name: "Stop",
      session_id: sessionId,
      transcript_path: projectFile(h, sessionId),
    })
  );

async function until(check, what, timeoutMs = 20_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function stopDaemon(h) {
  const pidFile = path.join(h, "data", "daemon.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await until(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    "the daemon to exit",
    10_000
  );
}

const total = (s) =>
  s.entries.reduce(
    (n, e) => n + e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens,
    0
  );
const sessionBatches = (b, sessionId) =>
  b.batches.flatMap((x) => x.snapshots).filter((s) => s.sessionId === sessionId);

for (const daemon of [false, true]) {
  const via = daemon ? "through the daemon" : "without the daemon";
  test(`a Stop posts its own session while the scanner is held on a backlog, ${via}`, async () => {
    const b = await backend();
    const h = home(b.url, isoAgo(3 * 3_600_000));
    try {
      for (let i = 0; i < 30; i++) {
        const id = randomUUID();
        writeSession(h, id, [
          assistant(id, `b${i}`, isoAgo(2 * 3_600_000 + i * 1000), {
            input_tokens: 3,
            output_tokens: 1,
          }),
        ]);
      }
      const scan = run(scanner, env(h, b.url, false));
      await until(() => b.singles.length > 0, "the scanner's first held post");
      const target = randomUUID();
      const at = isoAgo(60_000);
      const big = {
        input_tokens: 1000,
        output_tokens: 1000,
        cache_read_input_tokens: 40000,
        cache_creation_input_tokens: 8000,
      };
      const last = { ...big, output_tokens: 1790 };
      const messages = Array.from({ length: 8 }, (_, i) =>
        assistant(target, `m${i}`, at, i === 7 ? last : big)
      );
      writeSession(h, target, [...messages, ...messages, ...messages.slice(0, 7)]);
      await stop(h, b.url, daemon, target);
      await until(() => sessionBatches(b, target).length > 0, "the live session's batch");
      const hours = sessionBatches(b, target);
      assert.deepEqual(
        hours.map((s) => [s.usageDate, s.usageHour, total(s)]),
        [[at.slice(0, 10), Number(at.slice(11, 13)), 400_790]]
      );
      assert.equal(b.batches[0].generation, GENERATION);
      assert.equal(b.singles.length > 0 && !b.singles.some((s) => s.sessionId === target), true);
      b.release();
      await scan;
    } finally {
      b.release();
      await stopDaemon(h);
      b.server.closeAllConnections();
      await new Promise((r) => b.server.close(r));
      rmSync(h, { recursive: true, force: true });
    }
  });
}

test("a session that spans the login posts only the part after it, also after the ownership state is erased", async () => {
  const b = await backend();
  b.release();
  const loggedInAt = isoAgo(30 * 60_000);
  const h = home(b.url, loggedInAt);
  try {
    const id = randomUUID();
    const before = isoAgo(40 * 60_000);
    const after = isoAgo(20 * 60_000);
    writeSession(h, id, [
      assistant(id, "pre", before, { input_tokens: 10, output_tokens: 0 }),
      assistant(id, "post", after, { input_tokens: 20, output_tokens: 0 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length >= 1, "the first batch");
    assert.deepEqual(sessionBatches(b, id).map(total), [20]);
    rmSync(path.join(h, "data", "usage-sync-login.json"), { force: true });
    appendFileSync(
      projectFile(h, id),
      JSON.stringify(
        assistant(id, "late", isoAgo(10 * 60_000), { input_tokens: 5, output_tokens: 0 })
      ) + "\n"
    );
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length >= 2, "the second batch");
    const hourly = new Map();
    for (const s of sessionBatches(b, id)) hourly.set(`${s.usageDate}T${s.usageHour}`, s);
    const latest = [...hourly.values()];
    assert.equal(
      latest.reduce((n, s) => n + total(s), 0),
      25
    );
    assert.ok(sessionBatches(b, id).at(-1).revision > sessionBatches(b, id)[0].revision);
  } finally {
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
});

test("a Stop uploads nothing while the calling session turns usage off, and uploads once it is on", async () => {
  const b = await backend();
  b.release();
  const h = home(b.url, isoAgo(3_600_000));
  try {
    const id = randomUUID();
    writeSession(h, id, [
      assistant(id, "a", isoAgo(60_000), { input_tokens: 4, output_tokens: 0 }),
    ]);
    const offs = [
      { CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "true" },
      { CLAUDE_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "true" },
    ];
    for (const off of offs) await stop(h, b.url, true, id, off);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(sessionBatches(b, id).length, 0);
    await stop(h, b.url, true, id);
    await until(() => sessionBatches(b, id).length > 0, "the batch once usage is on");
    assert.deepEqual(sessionBatches(b, id).map(total), [4]);
  } finally {
    await stopDaemon(h);
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
});

test("the live upload keeps its state and log owner-only", async () => {
  const b = await backend();
  b.release();
  const h = home(b.url, isoAgo(3_600_000));
  try {
    const id = randomUUID();
    writeSession(h, id, [
      assistant(id, "a", isoAgo(60_000), { input_tokens: 4, output_tokens: 0 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length > 0, "the batch");
    const live = path.join(h, "data", "usage-live");
    const dir = () => path.join(live, readdirSync(live)[0]);
    await until(() => existsSync(path.join(dir(), `${id}.json`)), "the session state");
    const mode = (file) => statSync(file).mode & 0o777;
    assert.equal(mode(live), 0o700);
    assert.equal(mode(dir()), 0o700);
    for (const file of ["stream.json", `${id}.json`])
      assert.equal(mode(path.join(dir(), file)), 0o600, file);
    assert.equal(mode(path.join(h, "data", "usage-sync.log")), 0o600);
  } finally {
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
});
