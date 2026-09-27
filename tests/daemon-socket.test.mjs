// The daemon socket path fits in sun_path however long the data dir is (#169).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SOCKET_PATH_BYTES, daemonSocketPath } from "../scripts/lib/daemon-socket.mjs";
import { pingDaemon } from "../scripts/lib/daemon-client.mjs";

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

test("a long data dir gets a short per-user socket path keyed by the dir", async () => {
  const dir = await longDataDir();
  assert.ok(Buffer.byteLength(path.join(dir, "daemon.sock")) > MAX_SOCKET_PATH_BYTES);
  const socketPath = daemonSocketPath(dir);
  assert.ok(Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH_BYTES, socketPath);
  assert.equal(path.dirname(socketPath), path.join("/tmp", `armorclaude-${os.userInfo().uid}`));
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
    ARMORIQ_API_KEY: "",
    CLAUDE_PLUGIN_OPTION_API_KEY: "invalid-test-key",
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
