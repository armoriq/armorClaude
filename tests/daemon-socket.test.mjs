// The daemon socket path fits in sun_path however long the data dir is (#169).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_SOCKET_PATH_BYTES,
  assertTrustedSocketDir,
  daemonSocketPath,
  prepareSocketDir,
} from "../scripts/lib/daemon-socket.mjs";
import { pingDaemon } from "../scripts/lib/daemon-client.mjs";
import { tempHome } from "./helpers/login-profile.mjs";

const daemonScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "daemon.mjs"
);

async function longDataDir() {
  const base = await mkdtemp(path.join(os.tmpdir(), "armorclaude-sock-"));
  const dir = path.join(base, "d".repeat(Math.max(1, 120 - base.length)));
  mkdirSync(dir);
  return dir;
}

test("a short data dir keeps its socket inside the data dir", () => {
  assert.equal(
    daemonSocketPath("/home/u/.claude/armorclaude"),
    "/home/u/.claude/armorclaude/daemon.sock"
  );
});

test("on Windows the daemon listens on a named pipe keyed by the data dir", () => {
  const dir = "C:\\Users\\u\\.claude\\plugins\\data\\armorclaude-inline";
  const pipe = daemonSocketPath(dir, "win32");
  assert.match(pipe, /^\\\\\.\\pipe\\armorclaude-[0-9a-f]{16}$/);
  assert.equal(daemonSocketPath(dir, "win32"), pipe);
  assert.notEqual(daemonSocketPath(`${dir}x`, "win32"), pipe);
});

test("a long data dir gets a short per-user socket path keyed by the dir", async () => {
  const dir = await longDataDir();
  assert.ok(Buffer.byteLength(path.join(dir, "daemon.sock")) > MAX_SOCKET_PATH_BYTES);
  const socketPath = daemonSocketPath(dir);
  assert.ok(Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH_BYTES, socketPath);
  assert.equal(path.dirname(socketPath), path.join("/tmp", `armorclaude-${process.getuid()}`));
  assert.equal(daemonSocketPath(dir), socketPath);
  assert.notEqual(daemonSocketPath(`${dir}x`), socketPath);
});

test("a daemon whose data dir is too long for sun_path still serves, on the short path", async () => {
  const dataDir = await longDataDir();
  const env = {
    ...process.env,
    ARMORCLAUDE_DATA_DIR: dataDir,
    ARMORCLAUDE_RUNTIME_FILE: path.join(dataDir, "runtime.json"),
    ARMORCLAUDE_POLICY_FILE: path.join(dataDir, "policy.json"),
    HOME: tempHome(),
  };
  const child = spawn(process.execPath, [daemonScript], { env, stdio: "ignore", cwd: dataDir });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const socketPath = daemonSocketPath(dataDir);
  try {
    let ping = null;
    const until = Date.now() + 20_000;
    while (!ping?.ok && Date.now() < until && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 100));
      ping = await pingDaemon({ dataDir });
    }
    assert.ok(ping?.ok, "the daemon answered a ping");
    const dirMode = statSync(path.dirname(socketPath)).mode & 0o777;
    assert.equal(dirMode, 0o700);
    process.kill(child.pid, "SIGTERM");
    await exited;
    assert.equal(existsSync(socketPath), false, "shutdown removed the socket");
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, "SIGKILL");
  }
});

test("a socket directory is trusted only as a 0700 directory owned by this user", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "armorclaude-trust-"));
  const good = path.join(base, "good");
  mkdirSync(good, { mode: 0o700 });
  assert.doesNotThrow(() => assertTrustedSocketDir(good));

  const open = path.join(base, "open");
  mkdirSync(open, { mode: 0o700 });
  chmodSync(open, 0o755);
  assert.throws(() => assertTrustedSocketDir(open), /has mode 755/);

  const link = path.join(base, "link");
  symlinkSync(good, link);
  assert.throws(() => assertTrustedSocketDir(link), /is not a directory/);

  const file = path.join(base, "file");
  writeFileSync(file, "");
  assert.throws(() => assertTrustedSocketDir(file), /is not a directory/);
});

test("preparing a socket directory creates it 0700 and tightens one this user owns", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "armorclaude-prep-"));
  const fresh = path.join(base, "fresh");
  prepareSocketDir(fresh);
  assert.equal(statSync(fresh).mode & 0o777, 0o700);

  const loose = path.join(base, "loose");
  mkdirSync(loose, { mode: 0o700 });
  chmodSync(loose, 0o755);
  prepareSocketDir(loose);
  assert.equal(statSync(loose).mode & 0o777, 0o700);

  const link = path.join(base, "link");
  symlinkSync(fresh, link);
  assert.throws(() => prepareSocketDir(link), /is not a directory/);
});
