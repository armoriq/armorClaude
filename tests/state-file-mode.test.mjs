import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers/login-profile.mjs";
import { createAuditWal } from "../scripts/lib/audit-wal.mjs";
import { handleSessionStart } from "../scripts/lib/engine.mjs";
import {
  appendPrivateFileSync,
  openPrivateSync,
  writeJson,
  writePrivateFile,
  writePrivateFileSync,
} from "../scripts/lib/fs-store.mjs";
import { seedBuiltinProfiles } from "../scripts/lib/policy-profiles.mjs";
import {
  loadRuntimeState,
  saveRuntimeState,
  upsertSession,
} from "../scripts/lib/runtime-state.mjs";

process.umask(0o022);

const HOOK_ROUTER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "hook-router.mjs"
);

const DAEMON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "daemon.mjs"
);

async function modeOf(file) {
  return (await stat(file)).mode & 0o777;
}

async function tmpRoot() {
  return mkdtemp(path.join(os.tmpdir(), "ac-mode-"));
}

async function openDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o755 });
  await chmod(dir, 0o755);
  return dir;
}

async function openFile(file, text) {
  await writeFile(file, text);
  await chmod(file, 0o644);
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function daemonPid(dataDir) {
  return Number(await readFile(path.join(dataDir, "daemon.pid"), "utf8").catch(() => ""));
}

async function stopProcess(pid) {
  if (!pid || !isRunning(pid)) return;
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && isRunning(pid); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!isRunning(pid), `process ${pid} still running`);
}

test("writeJson creates a missing data dir 0700 and the file 0600", async () => {
  const dataDir = path.join(await tmpRoot(), "fresh", "armorclaude");
  await writeJson(path.join(dataDir, "policy.json"), { rules: [] });
  assert.equal(await modeOf(dataDir), 0o700);
  assert.equal(await modeOf(path.join(dataDir, "policy.json")), 0o600);
});

test("writeJson replaces a 0644 file with an owner-only one and leaves its existing dir alone", async () => {
  const projectDir = await openDir(path.join(await tmpRoot(), "project"));
  const file = path.join(projectDir, "state.json");
  await openFile(file, "{}");
  await writeJson(file, { secret: "x" });
  assert.equal(await modeOf(file), 0o600);
  assert.equal(await modeOf(projectDir), 0o755);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { secret: "x" });
});

test("runtime.json holding the prompt is owner-only", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  const runtimeFile = path.join(dataDir, "runtime.json");
  await openFile(runtimeFile, "{}");
  const state = await loadRuntimeState(runtimeFile);
  upsertSession(state, "s-mode", { lastPrompt: "deploy with token abc123" });
  await saveRuntimeState(runtimeFile, state);
  assert.match(await readFile(runtimeFile, "utf8"), /abc123/);
  assert.equal(await modeOf(runtimeFile), 0o600);
});

test("the audit WAL holding tool inputs and outputs is owner-only", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  const wal = createAuditWal({ dataDir });
  await wal.appendLine({ tool: "Bash", input: { command: "ls" }, output: { stdout: "a\nb\n" } });
  const audit = path.join(dataDir, "audit");
  const current = path.join(audit, "current.jsonl");
  assert.match(await readFile(current, "utf8"), /"stdout":"a\\nb\\n"/);
  assert.equal(await modeOf(current), 0o600);
  assert.equal(await modeOf(audit), 0o700);
  assert.equal(await modeOf(path.join(audit, "archive")), 0o700);

  const { endOffset } = await wal.readBatch();
  await wal.advanceOffset(endOffset);
  assert.equal(await modeOf(path.join(audit, "shipped.offset")), 0o600);
});

test("the audit WAL tightens a 0644 log, offset and archive left in 0755 dirs", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  const audit = await openDir(path.join(dataDir, "audit"));
  const archive = await openDir(path.join(audit, "archive"));
  const current = path.join(audit, "current.jsonl");
  const offset = path.join(audit, "shipped.offset");
  const segment = path.join(archive, "2026-09-01-001.jsonl");
  await openFile(current, `${JSON.stringify({ tool: "Bash" })}\n`);
  await openFile(offset, "0");
  await openFile(segment, `${JSON.stringify({ tool: "Read" })}\n`);

  const wal = createAuditWal({ dataDir });
  await wal.appendLine({ tool: "Write" });
  for (const file of [current, offset, segment]) assert.equal(await modeOf(file), 0o600, file);
  for (const dir of [dataDir, audit, archive]) assert.equal(await modeOf(dir), 0o700, dir);
  assert.equal((await readFile(current, "utf8")).trim().split("\n").length, 2);
});

test("a rotated audit segment stays owner-only", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  const wal = createAuditWal({ dataDir, rotateBytes: 1 });
  await wal.appendLine({ tool: "Bash" });
  const { endOffset } = await wal.readBatch();
  await wal.advanceOffset(endOffset);
  const archive = path.join(dataDir, "audit", "archive");
  const segments = await readdir(archive);
  assert.equal(segments.length, 1);
  assert.equal(await modeOf(path.join(archive, segments[0])), 0o600);
});

test("profiles are written 0600 and an existing 0644 profile is tightened", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  const profiles = await openDir(path.join(dataDir, "profiles"));
  const mine = path.join(profiles, "mine.json");
  await openFile(mine, JSON.stringify({ profile: { name: "mine", createdBy: "user" } }));
  await seedBuiltinProfiles({ dataDir });
  assert.equal(await modeOf(profiles), 0o700);
  assert.equal(await modeOf(mine), 0o600);
  assert.equal(await modeOf(path.join(profiles, "balanced.json")), 0o600);
});

test("the onboarding flag is owner-only", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "mode-onboard" },
    {
      mode: "enforce",
      dataDir,
      policyFile: path.join(dataDir, "policy.json"),
      runtimeFile: path.join(dataDir, "runtime.json"),
      useProduction: false,
      backendEndpoint: "http://127.0.0.1:3000",
      csrgEndpoint: "http://127.0.0.1:8080",
      apiKey: "",
      useSdkIntent: false,
      auditEnabled: false,
      planningEnabled: false,
      debug: false,
    }
  );
  assert.equal(await modeOf(path.join(dataDir, "onboarding-shown")), 0o600);
});

test("the hook router makes an existing data dir 0700", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  const child = spawn(process.execPath, [HOOK_ROUTER], {
    stdio: ["pipe", "ignore", "ignore"],
    env: {
      PATH: process.env.PATH,
      HOME: tempHome(),
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
      ARMORCLAUDE_DATA_DIR: dataDir,
      ARMORIQ_ENV: "local",
    },
  });
  try {
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", session_id: "mode-router" }));
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(await modeOf(dataDir), 0o700);
  } finally {
    await stopProcess(await daemonPid(dataDir));
  }
});

test("the sync writers create 0600 files and tighten 0644 ones", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  const log = path.join(dataDir, "some.log");
  await openFile(log, "old\n");
  appendPrivateFileSync(log, "new\n");
  assert.equal(await readFile(log, "utf8"), "old\nnew\n");
  assert.equal(await modeOf(log), 0o600);
  assert.equal(await modeOf(dataDir), 0o755);

  const syncDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  const appended = path.join(syncDir, "daemon.out");
  await openFile(appended, "");
  closeSync(openPrivateSync(appended, "a"));
  assert.equal(await modeOf(appended), 0o600);
  const fresh = path.join(syncDir, "new", "marker");
  writePrivateFileSync(fresh, "1");
  assert.equal(await modeOf(path.dirname(fresh)), 0o700);
  const marker = path.join(syncDir, "marker");
  writePrivateFileSync(marker, "1");
  assert.equal(await modeOf(marker), 0o600);
});

test("private modes keep owner-only bits and concurrent writes never share a temp file", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "armorclaude"));
  const readOnly = path.join(dataDir, "read-only");
  await writeFile(readOnly, "x", { mode: 0o400 });
  await chmod(readOnly, 0o400);
  closeSync(openPrivateSync(readOnly, "r"));
  assert.equal(await modeOf(readOnly), 0o400);

  const target = path.join(dataDir, "state.json");
  await Promise.all(Array.from({ length: 20 }, (_, i) => writePrivateFile(target, String(i))));
  assert.match(await readFile(target, "utf8"), /^\d+$/);
  assert.deepEqual(
    (await readdir(dataDir)).filter((f) => f.includes(".tmp.")),
    []
  );
});

test("the daemon makes its data dir 0700 and its PID file 0600", async () => {
  const dataDir = await openDir(path.join(await tmpRoot(), "d"));
  const pidPath = path.join(dataDir, "daemon.pid");
  await openFile(pidPath, "999999");
  const child = spawn(process.execPath, [DAEMON], {
    stdio: "ignore",
    cwd: dataDir,
    env: {
      PATH: process.env.PATH,
      HOME: tempHome(),
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
      ARMORCLAUDE_DATA_DIR: dataDir,
      ARMORCLAUDE_RUNTIME_FILE: path.join(dataDir, "runtime.json"),
      ARMORCLAUDE_POLICY_FILE: path.join(dataDir, "policy.json"),
      ARMORCLAUDE_DEBUG: "false",
      ARMORCLAUDE_USE_SDK_INTENT: "false",
      ARMORIQ_ENV: "local",
    },
  });
  try {
    for (let i = 0; i < 50 && !existsSync(path.join(dataDir, "daemon.sock")); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(existsSync(path.join(dataDir, "daemon.sock")), "daemon socket");
    assert.equal((await readFile(pidPath, "utf8")).trim(), String(child.pid));
    assert.equal(await modeOf(pidPath), 0o600);
    assert.equal(await modeOf(dataDir), 0o700);
    assert.equal(await modeOf(path.join(dataDir, "profiles")), 0o700);
  } finally {
    await stopProcess(child.pid);
  }
});
