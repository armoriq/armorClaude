import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import armoriqSdk from "@armoriq/sdk-dev";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const hookRouter = path.join(repoRoot, "scripts", "hook-router.mjs");
export const KEY = "ak_test_live_usage_0001";
export const USER = `user-of-${KEY}`;
export const isoAgo = (ms) => new Date(Date.now() - ms).toISOString();

export function backend() {
  const batches = [];
  const singles = [];
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const b = { batches, singles, release, generation: GENERATION, onBatch: null };
  Object.assign(b, { requestId: null, reports: [], runs: new Map(), acked: new Map() });
  const stale = (run) => run?.mode === "history" && run.requestId !== b.requestId;
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
        return reply(200, { requestId: b.requestId, requestedAt: b.requestId && isoAgo(0) });
      if (req.url === "/dashboard/token-usage/stream")
        return reply(200, { generation: b.generation });
      if (req.url.startsWith("/dashboard/token-usage/runs/")) {
        const runId = req.url.split("/").at(-1);
        b.reports.push({ runId, ...body });
        if (stale(body)) return reply(409, { message: "History request is no longer current" });
        const acked = b.acked.get(runId)?.size ?? 0;
        if (body.phase === "complete" && !(acked >= body.total))
          return reply(409, { message: "Run has unacknowledged session-hours" });
        b.runs.set(runId, body);
        const historyCompleted = body.mode === "history" && body.phase === "complete";
        if (historyCompleted) b.requestId = null;
        return reply(200, { applied: true, historyCompleted, run: { runId } });
      }
      if (req.url === "/dashboard/token-usage/batch") {
        if (body.generation !== b.generation)
          return reply(409, { message: "Usage stream generation changed" });
        if (body.runId && !b.runs.has(body.runId))
          return reply(409, { message: "Unknown usage sync run" });
        if (stale(b.runs.get(body.runId)))
          return reply(409, { message: "History request is no longer current" });
        batches.push(body);
        if (b.onBatch?.(res, body)) return;
        if (body.runId) {
          const hours = b.acked.get(body.runId) ?? new Set();
          for (const s of body.snapshots) hours.add(`${s.sessionId}|${s.usageDate}|${s.usageHour}`);
          b.acked.set(body.runId, hours);
        }
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
      resolve(Object.assign(b, { server, url: `http://127.0.0.1:${server.address().port}` }))
    )
  );
}

export const GENERATION = randomUUID();

export function login(home, url, at) {
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

export function home(url, loggedInAt) {
  const dir = path.join(tmpdir(), `live-usage-${randomUUID()}`);
  assert.ok(dir.startsWith(tmpdir()));
  mkdirSync(path.join(dir, ".claude", "projects", "-work-repo"), { recursive: true });
  login(dir, url, loggedInAt);
  return dir;
}

export const projectFile = (h, sessionId) =>
  path.join(h, ".claude", "projects", "-work-repo", `${sessionId}.jsonl`);

export const assistant = (sessionId, id, timestamp, usage) => ({
  type: "assistant",
  sessionId,
  cwd: "/work/repo",
  timestamp,
  requestId: `r-${id}`,
  message: { id, model: "claude-opus", usage },
});

export function writeSession(h, sessionId, lines) {
  writeFileSync(projectFile(h, sessionId), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

export function env(h, url, daemon) {
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

export function run(script, environment, stdin = "") {
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

export const stop = (h, url, daemon, sessionId, extra = {}) =>
  run(
    hookRouter,
    { ...env(h, url, daemon), ...extra },
    JSON.stringify({
      hook_event_name: "Stop",
      session_id: sessionId,
      transcript_path: projectFile(h, sessionId),
    })
  );

export async function until(check, what, timeoutMs = 20_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function stopDaemon(h) {
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

export const total = (s) =>
  s.entries.reduce(
    (n, e) => n + e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheWriteTokens,
    0
  );
export const sessionBatches = (b, sessionId) =>
  b.batches.flatMap((x) => x.snapshots).filter((s) => s.sessionId === sessionId);

export const liveFiles = (h, sessionId) => {
  const root = path.join(h, "data", "usage-live");
  const dir = path.join(root, readdirSync(root)[0]);
  const queue = path.join(dir, `${sessionId}.queue`);
  return {
    lock: path.join(dir, `${sessionId}.lock`),
    queued: () => (existsSync(queue) ? readdirSync(queue).filter((n) => n.endsWith(".json")) : []),
    refused: () => {
      const dir = path.join(queue, "refused");
      const names = existsSync(dir) ? readdirSync(dir) : [];
      return names.map((n) => JSON.parse(readFileSync(path.join(dir, n), "utf8")));
    },
  };
};

export async function settled(h, sessionId) {
  const files = liveFiles(h, sessionId);
  await until(() => !existsSync(files.lock), "the upload to finish");
  return files;
}

export async function withSession(fn) {
  const b = await backend();
  b.release();
  const h = home(b.url, isoAgo(3 * 3_600_000));
  try {
    await fn(b, h, randomUUID());
  } finally {
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
}

export const usageLine = (id, msg, at, usage) =>
  JSON.stringify(assistant(id, msg, at, usage)) + "\n";

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
