import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { processInfo } from "../scripts/lib/usage-sessions.mjs";
import {
  alive,
  assistant,
  backend,
  env,
  home,
  hookRouter,
  run,
  sessionBatches,
  until,
  writeSession,
} from "./helpers/live-usage.mjs";

const HOUR = 3_600_000;
const hourStart = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR;
const at = (minute) => new Date(hourStart + minute * 60_000).toISOString();

const HARNESS = `
const { spawnSync } = require("node:child_process");
const [command, args, input] = JSON.parse(process.argv[1]);
spawnSync(command, args, { input, stdio: ["pipe", "ignore", "inherit"] });
process.stdout.write("registered\\n");
setInterval(() => {}, 1000);
`;

async function startHarness(h, b, sessionId, viaShell = false) {
  const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId });
  const router = viaShell
    ? ["/bin/sh", ["-c", `"${process.execPath}" "${hookRouter}"; :`]]
    : [process.execPath, [hookRouter]];
  const child = spawn(process.execPath, ["-e", HARNESS, JSON.stringify([...router, input])], {
    env: env(h, b.url, false),
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  return child;
}

const contextDir = (h) => {
  const root = path.join(h, "data", "usage-live");
  return path.join(root, readdirSync(root)[0]);
};
const readJsonFile = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
const workerPid = (h) => Number(readJsonFile(path.join(contextDir(h), "worker.lock")) ?? 0);
const sessionsOf = (h) => readJsonFile(path.join(contextDir(h), "sessions.json")) ?? {};
const reportsOf = (b, mode) => b.reports.filter((r) => r.mode === mode);

async function withServing(fn) {
  const b = await backend();
  b.release();
  const h = home(b.url, at(0));
  const cleanup = [];
  try {
    await fn(b, h, cleanup);
  } finally {
    for (const pid of [...cleanup, existsSync(path.join(h, "data", "usage-live")) && workerPid(h)])
      if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
}

test("SessionStart through a shell registers the shell's parent, and the worker exits once that process is gone", async () => {
  await withServing(async (b, h, cleanup) => {
    const id = randomUUID();
    const harness = await startHarness(h, b, id, true);
    cleanup.push(harness.pid);
    const entry = sessionsOf(h)[id];
    assert.equal(entry.pid, harness.pid);
    assert.equal(entry.startedAt, processInfo(harness.pid).startedAt);
    await until(() => alive(workerPid(h)), "the worker to start");
    const worker = workerPid(h);
    harness.kill("SIGKILL");
    await until(() => !alive(worker), "the worker to exit", 15_000);
  });
});

test("with no further hooks the worker retries a failed batch when due, uploads a transcript created meanwhile, and completes a history request made while it runs", async () => {
  await withServing(async (b, h, cleanup) => {
    const first = randomUUID();
    writeSession(h, first, [assistant(first, "a", at(20), { input_tokens: 3 })]);
    b.onBatch = (res) => {
      b.onBatch = null;
      res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ message: "busy" }));
      return true;
    };
    const harness = await startHarness(h, b, randomUUID());
    cleanup.push(harness.pid);
    await until(
      () => reportsOf(b, "discovery").some((r) => r.phase === "retrying"),
      "the failed pass"
    );
    const retrying = reportsOf(b, "discovery").find((r) => r.phase === "retrying");
    assert.equal(retrying.errorCode, "upload_failed");
    assert.ok(Date.parse(retrying.retryAt) > Date.now() - 5_000);

    const later = randomUUID();
    writeSession(h, later, [assistant(later, "b", at(25), { input_tokens: 4 })]);
    b.requestId = randomUUID();
    await until(() => reportsOf(b, "history").some((r) => r.phase === "complete"), "the next pass");
    assert.equal(b.requestId, null);
    assert.equal(sessionBatches(b, later).length > 0, true);
    const done = reportsOf(b, "discovery").at(-1);
    assert.deepEqual([done.phase, done.total], ["complete", 2]);
  });
});

test("SessionEnd of the last session stops the worker and keeps the harness running", async () => {
  await withServing(async (b, h, cleanup) => {
    const id = randomUUID();
    const harness = await startHarness(h, b, id);
    cleanup.push(harness.pid);
    await until(() => alive(workerPid(h)), "the worker to start");
    const worker = workerPid(h);
    const end = await run(
      hookRouter,
      env(h, b.url, false),
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: id })
    );
    assert.equal(end.code, 0, end.stderr);
    assert.deepEqual(sessionsOf(h), {});
    await until(() => !alive(worker), "the worker to exit", 15_000);
    assert.equal(existsSync(path.join(contextDir(h), "worker.lock")), false);
    assert.equal(alive(harness.pid), true);
  });
});
