import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendDaemonLog, capDaemonLog, daemonLogPath } from "../scripts/lib/daemon-log.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const hookRouter = path.resolve(here, "..", "scripts", "hook-router.mjs");

function numberedLines(count) {
  return Array.from({ length: count }, (_, i) => `line-${String(i).padStart(5, "0")}\n`).join("");
}

test("capDaemonLog leaves a log under the cap untouched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-log-under-"));
  const logPath = daemonLogPath(dir);
  writeFileSync(logPath, numberedLines(10));
  capDaemonLog(logPath, 1024);
  assert.equal(readFileSync(logPath, "utf8"), numberedLines(10));
});

test("capDaemonLog ignores a missing log", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-log-missing-"));
  capDaemonLog(daemonLogPath(dir), 1024);
});

test("capDaemonLog keeps the newest whole lines once the log passes the cap", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-log-over-"));
  const logPath = daemonLogPath(dir);
  writeFileSync(logPath, numberedLines(1000));
  capDaemonLog(logPath, 4096);
  const kept = readFileSync(logPath, "utf8");
  assert.ok(kept.length <= 2048, `kept ${kept.length} bytes`);
  assert.match(kept, /^line-\d{5}\n/);
  assert.ok(kept.endsWith("line-00999\n"));
});

test("an append-mode writer keeps writing contiguously after the cap truncates its file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-log-fd-"));
  const logPath = daemonLogPath(dir);
  const fd = openSync(logPath, "a");
  try {
    writeSync(fd, numberedLines(1000));
    capDaemonLog(logPath, 4096);
    const sizeAfterCap = statSync(logPath).size;
    assert.ok(sizeAfterCap <= 2048, `kept ${sizeAfterCap} bytes`);
    writeSync(fd, "after-cap\n");
    const content = readFileSync(logPath, "utf8");
    assert.equal(content.length, sizeAfterCap + "after-cap\n".length);
    assert.ok(!content.includes("\0"));
    assert.ok(content.endsWith("line-00999\nafter-cap\n"));
  } finally {
    closeSync(fd);
  }
});

test("appendDaemonLog caps the log before appending", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-log-append-"));
  const logPath = daemonLogPath(dir);
  writeFileSync(logPath, "x".repeat(2 * 1024 * 1024) + "\n");
  appendDaemonLog(dir, "fresh line");
  assert.ok(statSync(logPath).size <= 1024 * 1024);
  assert.ok(readFileSync(logPath, "utf8").endsWith("fresh line\n"));
});

function runHook(dataDir, input) {
  const child = spawn(process.execPath, [hookRouter], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ARMORCLAUDE_DATA_DIR: dataDir,
      ARMORCLAUDE_RUNTIME_FILE: path.join(dataDir, "runtime.json"),
      ARMORCLAUDE_POLICY_FILE: path.join(dataDir, "policy.json"),
      ARMORCLAUDE_DEBUG: "false",
      ARMORCLAUDE_USE_SDK_INTENT: "false",
      ARMORIQ_API_KEY: "",
      CLAUDE_PLUGIN_OPTION_API_KEY: "invalid-test-key",
    },
    cwd: dataDir,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.resume();
  child.stdin.end(JSON.stringify(input));
  return new Promise((resolve) => child.once("exit", (code) => resolve({ code, stderr })));
}

test("hook router records each in-process fallback in daemon.log, not on stderr", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-router-fallback-"));
  await writeFile(path.join(dataDir, "profiles"), "not a directory");
  const input = {
    hook_event_name: "PreToolUse",
    session_id: "sess-fallback-1",
    tool_name: "Read",
    tool_input: { file_path: "x.txt" },
  };
  for (let i = 0; i < 2; i++) {
    const { code, stderr } = await runHook(dataDir, input);
    assert.equal(code, 0);
    assert.doesNotMatch(stderr, /daemon unreachable/);
  }
  const log = readFileSync(daemonLogPath(dataDir), "utf8");
  const fallbacks = log.split("\n").filter((l) => l.includes("daemon unreachable"));
  assert.equal(fallbacks.length, 2);
  assert.match(
    fallbacks[0],
    /^\[armorclaude\] daemon unreachable, handling PreToolUse in-process pid=\d+ at=\S+: daemon exited \(code=1, signal=null\)/
  );
});
