/* eslint-disable */
/**
 * Phase 4 Tier B daemon tests.
 *
 * These spawn the actual daemon as a child process and exercise it through
 * the daemon-client. Each test uses a unique tmpdir so the socket + PID
 * file don't collide. Cleanup is in `afterEach`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const daemonScript = path.join(repoRoot, "scripts", "daemon.mjs");

function buildEnv(dataDir) {
  return {
    ...process.env,
    ARMORCLAUDE_DATA_DIR: dataDir,
    ARMORCLAUDE_RUNTIME_FILE: path.join(dataDir, "runtime.json"),
    ARMORCLAUDE_POLICY_FILE: path.join(dataDir, "policy.json"),
    ARMORCLAUDE_DEBUG: "false",
    ARMORCLAUDE_USE_SDK_INTENT: "false",
    ARMORIQ_API_KEY: "",
  };
}

async function spawnDaemonChild(dataDir) {
  const env = buildEnv(dataDir);
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: "ignore",
    env,
    cwd: dataDir,
  });
  child.unref();
  // Poll for socket to appear
  const socketPath = path.join(dataDir, "daemon.sock");
  for (let i = 0; i < 30; i++) {
    if (existsSync(socketPath)) return { child, socketPath };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("daemon did not create socket within 3s");
}

async function killDaemon(child, dataDir) {
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {}
  // give it a moment to clean up
  await new Promise((r) => setTimeout(r, 200));
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {}
}

async function loadConfigFor(dataDir) {
  const env = buildEnv(dataDir);
  const oldEnv = { ...process.env };
  Object.assign(process.env, env);
  // Clear any stale module cache (ESM doesn't really support this so we
  // just import freshly each time the test loads).
  const mod = await import(`../scripts/lib/config.mjs?cache=${Date.now()}`);
  Object.assign(process.env, oldEnv);
  return mod.loadConfig(env);
}

test("daemon: ping responds with version + uptime", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-daemon-ping-"));
  const { child } = await spawnDaemonChild(dataDir);
  try {
    const config = await loadConfigFor(dataDir);
    const { pingDaemon } = await import("../scripts/lib/daemon-client.mjs");
    const reply = await pingDaemon(config);
    assert.ok(reply, "ping should return a reply");
    assert.equal(reply.ok, true);
    assert.ok(typeof reply.version === "string");
    assert.ok(reply.uptime >= 0);
  } finally {
    await killDaemon(child, dataDir);
  }
});

test("daemon: PreToolUse roundtrip returns null for fast-path tool", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-daemon-pre-"));
  const { child } = await spawnDaemonChild(dataDir);
  try {
    const config = await loadConfigFor(dataDir);
    const { dispatchViaDaemon } = await import("../scripts/lib/daemon-client.mjs");
    // 'read' is in the Phase 4 A1 fast-path whitelist — should be allowed
    // without any plan / token / backend, regardless of intentRequired.
    const output = await dispatchViaDaemon({
      event: "PreToolUse",
      input: {
        hook_event_name: "PreToolUse",
        session_id: "sess-daemon-1",
        tool_name: "read",
        tool_input: { file_path: "x.txt" },
      },
      config,
    });
    assert.equal(output, null, `read should fast-path; got ${JSON.stringify(output)}`);
  } finally {
    await killDaemon(child, dataDir);
  }
});

test("daemon: SessionStart returns context output", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-daemon-start-"));
  const { child } = await spawnDaemonChild(dataDir);
  try {
    const config = await loadConfigFor(dataDir);
    const { dispatchViaDaemon } = await import("../scripts/lib/daemon-client.mjs");
    const output = await dispatchViaDaemon({
      event: "SessionStart",
      input: {
        hook_event_name: "SessionStart",
        session_id: "sess-daemon-2",
        source: "startup",
      },
      config,
    });
    assert.ok(output?.hookSpecificOutput?.additionalContext);
    assert.match(output.hookSpecificOutput.additionalContext, /ArmorClaude active/i);
  } finally {
    await killDaemon(child, dataDir);
  }
});

test("daemon: roundtrip latency p95 < 50ms (over Unix socket)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-daemon-perf-"));
  const { child } = await spawnDaemonChild(dataDir);
  try {
    const config = await loadConfigFor(dataDir);
    const { dispatchViaDaemon } = await import("../scripts/lib/daemon-client.mjs");
    const samples = [];
    // Warm up — first call sometimes pays connection-establish cost.
    await dispatchViaDaemon({
      event: "PreToolUse",
      input: {
        hook_event_name: "PreToolUse",
        session_id: "warm",
        tool_name: "read",
        tool_input: {},
      },
      config,
    });
    for (let i = 0; i < 30; i++) {
      const start = process.hrtime.bigint();
      await dispatchViaDaemon({
        event: "PreToolUse",
        input: {
          hook_event_name: "PreToolUse",
          session_id: "perf-" + i,
          tool_name: "read",
          tool_input: { file_path: `f${i}.txt` },
        },
        config,
      });
      samples.push(Number(process.hrtime.bigint() - start) / 1_000_000);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const p50 = samples[Math.floor(samples.length * 0.5)];
    assert.ok(
      p95 < 50,
      `daemon roundtrip p95 should be < 50ms; got p50=${p50.toFixed(2)} p95=${p95.toFixed(2)}`
    );
  } finally {
    await killDaemon(child, dataDir);
  }
});

test("daemon: concurrent hooks for SAME session serialize (runtime-state stays consistent)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-daemon-conc-"));
  const { child } = await spawnDaemonChild(dataDir);
  try {
    const config = await loadConfigFor(dataDir);
    const { dispatchViaDaemon } = await import("../scripts/lib/daemon-client.mjs");
    // Fire SessionStart 10× concurrently for the same session_id.
    // Per-session lock should serialize them; final runtime.json should
    // have a single sess-conc-1 entry, not corrupted.
    const calls = Array.from({ length: 10 }, () =>
      dispatchViaDaemon({
        event: "SessionStart",
        input: {
          hook_event_name: "SessionStart",
          session_id: "sess-conc-1",
          source: "startup",
        },
        config,
      })
    );
    const results = await Promise.all(calls);
    for (const r of results) {
      assert.ok(r?.hookSpecificOutput?.additionalContext);
    }
    // Read the runtime file directly and assert it's valid JSON with the session present.
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.join(dataDir, "runtime.json"), "utf8");
    const parsed = JSON.parse(raw);
    assert.ok(parsed.sessions["sess-conc-1"]);
  } finally {
    await killDaemon(child, dataDir);
  }
});

test("daemon-client: spawnDaemon on missing socket (auto-spawn)", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-daemon-spawn-"));
  // Don't pre-spawn — let the client auto-spawn.
  let childPid;
  try {
    const config = await loadConfigFor(dataDir);
    const { dispatchViaDaemon, pingDaemon } = await import("../scripts/lib/daemon-client.mjs");
    const output = await dispatchViaDaemon({
      event: "SessionStart",
      input: {
        hook_event_name: "SessionStart",
        session_id: "sess-spawn-1",
        source: "startup",
      },
      config,
    });
    assert.ok(output?.hookSpecificOutput?.additionalContext);
    // A daemon should now be running. Prove it by ping.
    const ping = await pingDaemon(config);
    assert.ok(ping?.ok);
  } finally {
    // Kill any daemon that auto-spawned
    try {
      const { readFile } = await import("node:fs/promises");
      const pid = parseInt(await readFile(path.join(dataDir, "daemon.pid"), "utf8"), 10);
      if (Number.isFinite(pid)) process.kill(pid, "SIGTERM");
    } catch {}
  }
});
