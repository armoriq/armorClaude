import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { obsFlush, observeHook } from "../scripts/lib/observability.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookRouter = path.join(repoRoot, "scripts", "hook-router.mjs");
const daemonScript = path.join(repoRoot, "scripts", "daemon.mjs");
const API_KEY = "ak_test_otelshipping0000000000000000";

function protoFields(buf) {
  const fields = [];
  let i = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = buf[i++];
      value |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return value;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const no = key >> 3;
    const wire = key & 7;
    if (wire === 0) fields.push({ no, value: varint() });
    else if (wire === 1) {
      fields.push({ no, fixed64: buf.readBigUInt64LE(i) });
      i += 8;
    } else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = Number(varint());
      fields.push({ no, bytes: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

const sub = (buf, no) => protoFields(buf).filter((f) => f.no === no && f.bytes);

const STATUS_CODES = { 0: "unset", 1: "ok", 2: "error" };

// Span status(15) -> code(3)
function spanStatus(span) {
  const status = sub(span, 15)[0];
  const code = status ? protoFields(status.bytes).find((f) => f.no === 3) : undefined;
  return STATUS_CODES[Number(code?.value ?? 0n)];
}

const hexField = (span, no) => sub(span, no)[0]?.bytes.toString("hex") || null;

// ExportTraceServiceRequest -> ResourceSpans(1) -> ScopeSpans(2) -> Span(2): trace_id(1),
// span_id(2), parent_span_id(4), name(5), start_time_unix_nano(7), end_time_unix_nano(8),
// attributes(9)
function decodeSpans(body) {
  const spans = [];
  for (const resourceSpans of sub(body, 1)) {
    for (const scopeSpans of sub(resourceSpans.bytes, 2)) {
      for (const span of sub(scopeSpans.bytes, 2)) {
        const name = sub(span.bytes, 5)[0]?.bytes.toString("utf8");
        const attributes = {};
        for (const kv of sub(span.bytes, 9)) {
          const key = sub(kv.bytes, 1)[0]?.bytes.toString("utf8");
          const value = sub(kv.bytes, 2)[0];
          const text = value ? sub(value.bytes, 1)[0] : undefined;
          if (key && text) attributes[key] = text.bytes.toString("utf8");
        }
        spans.push({
          name,
          attributes,
          status: spanStatus(span.bytes),
          traceId: hexField(span.bytes, 1),
          spanId: hexField(span.bytes, 2),
          parentSpanId: hexField(span.bytes, 4),
          startTimeUnixNano: protoFields(span.bytes).find((f) => f.no === 7)?.fixed64,
          endTimeUnixNano: protoFields(span.bytes).find((f) => f.no === 8)?.fixed64,
        });
      }
    }
  }
  return spans;
}

async function startBackend({ holdExports = false, content = false, exportDelayMs = 0 } = {}) {
  const exports = [];
  const delivered = [];
  const exportTimes = [];
  const heldExports = [];
  const lease = () =>
    JSON.stringify({
      captureMode: content ? "enhanced" : "metadata",
      contentCaptureAllowed: content,
      revision: 1,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/observability/policy/lease") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(lease());
        return;
      }
      if (req.method === "POST" && req.url === "/v1/traces") {
        exportTimes.push(Date.now());
        const spans = decodeSpans(Buffer.concat(chunks));
        exports.push(...spans);
        const answer = () => {
          if (req.socket.destroyed) return;
          delivered.push(...spans);
          res.writeHead(200, { "content-type": "application/x-protobuf" });
          res.end();
        };
        if (holdExports) heldExports.push(answer);
        else setTimeout(answer, exportDelayMs);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    exports,
    delivered,
    exportTimes,
    releaseExports() {
      holdExports = false;
      for (const answer of heldExports.splice(0)) answer();
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

// The daemon exits on startup when profiles is a file, so each hook runs in-process.
async function withoutDaemon(dataDir) {
  await rm(path.join(dataDir, "profiles"), { recursive: true, force: true });
  await writeFile(path.join(dataDir, "profiles"), "not a directory");
}

function pluginEnv(home, dataDir, backendUrl) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    ARMORCLAUDE_RUNTIME_FILE: path.join(dataDir, "runtime.json"),
    ARMORCLAUDE_POLICY_FILE: path.join(dataDir, "policy.json"),
    ARMORIQ_ENV: "local",
    ARMORIQ_BACKEND_URL: backendUrl,
    ARMORIQ_CSRG_URL: backendUrl,
    CLAUDE_PLUGIN_OPTION_API_KEY: API_KEY,
  };
}

function runHook(env, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookRouter], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function runSession(env, session_id) {
  const hook = async (payload) => {
    const { code } = await runHook(env, { session_id, ...payload });
    assert.equal(code, 0, payload.hook_event_name);
  };
  await hook({ hook_event_name: "SessionStart", source: "startup" });
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "read package.json" });
  for (const tool_name of ["Read", "Grep"]) {
    const tool = { tool_name, tool_input: { file_path: "package.json" } };
    await hook({ hook_event_name: "PreToolUse", ...tool });
    await hook({ hook_event_name: "PostToolUse", ...tool, tool_response: { ok: true } });
  }
  await hook({ hook_event_name: "Stop", stop_hook_active: false });
  await hook({ hook_event_name: "SessionEnd", reason: "other" });
}

function storedSpans(exports) {
  return [...new Map(exports.map((s) => [`${s.traceId}/${s.spanId}`, s])).values()];
}

test("a session run entirely on the fallback is one trace under one root that ends completed (#167, #178)", async () => {
  const backend = await startBackend();
  try {
    const home = await tempDir("aq-home-");
    const dataDir = await tempDir("aq-fallback-");
    await withoutDaemon(dataDir);
    const env = pluginEnv(home, dataDir, backend.url);
    const session_id = randomUUID();
    await runSession(env, session_id);
    assert.ok(!existsSync(path.join(dataDir, "daemon.sock")), "no daemon served these hooks");

    const traces = new Set(backend.exports.map((s) => s.traceId));
    assert.equal(traces.size, 1, "one trace for the session");
    const roots = backend.exports.filter((s) => s.name === "armoriq.agent.run");
    const ends = roots.map((r) => r.endTimeUnixNano);
    assert.deepEqual(rootOutcomes(roots), [...Array(6).fill("unknown"), "completed"]);
    assert.equal(new Set(roots.map((r) => r.spanId)).size, 1, "every delivery is one root span");
    assert.equal(new Set(roots.map((r) => r.startTimeUnixNano)).size, 1, "with one start time");
    assert.ok(
      ends.every((end, i) => i === 0 || end > ends[i - 1]),
      "each copy ends later"
    );
    assert.ok(roots.every((r) => r.status === "ok" && r.parentSpanId === null));
    for (const span of backend.exports) {
      assert.equal(span.attributes["armoriq.session_id"], session_id, span.name);
      if (span.name !== "armoriq.agent.run") {
        assert.equal(span.parentSpanId, roots[0].spanId, `${span.name} hangs off the root`);
      }
    }
    assert.equal(storedSpans(backend.exports).length, 5, "1 root, 2 policy and 2 tool spans");
    assert.equal(readdirSync(path.join(dataDir, "obs-roots")).length, 0, "marker removed");
  } finally {
    await backend.close();
  }
});

function daemonRequest(socketPath, message) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = "";
    sock.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
    sock.on("error", reject);
    sock.write(`${JSON.stringify(message)}\n`);
  });
}

async function waitFor(predicate, ms, what) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function startDaemon(env, dataDir) {
  const child = spawn(process.execPath, [daemonScript], { env, stdio: "ignore", cwd: dataDir });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { child, exited, socketPath: path.join(dataDir, "daemon.sock") };
}

function daemonHook(socketPath, sessionId, event, input = {}) {
  return daemonRequest(socketPath, {
    type: "hook",
    reqId: event,
    event,
    input: { session_id: sessionId, hook_event_name: event, ...input },
  });
}

const rootOutcomes = (exports) =>
  exports
    .filter((s) => s.name === "armoriq.agent.run")
    .map((r) => r.attributes["gen_ai.task.outcome"]);

function killIfRunning(child) {
  if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, "SIGKILL");
}

test("daemon replies to Stop without waiting on the span export, and its shutdown ships the open root", async () => {
  const backend = await startBackend({ holdExports: true });
  const home = await tempDir("aq-home-");
  const dataDir = await tempDir("aq-daemon-");
  const { child, exited, socketPath } = startDaemon(pluginEnv(home, dataDir, backend.url), dataDir);
  try {
    await waitFor(() => existsSync(socketPath), 20_000, "the daemon socket");
    const sessionId = randomUUID();
    const hook = async (event, input) => {
      const reply = await daemonHook(socketPath, sessionId, event, input);
      assert.ok(!reply.error, reply.error);
      return Date.now();
    };
    const tool = { tool_name: "Bash", tool_input: { command: "ls" } };
    await hook("SessionStart");
    await hook("PreToolUse", tool);
    await hook("PostToolUse", { ...tool, tool_response: { stdout: "a\n" } });
    const stopRepliedAt = await hook("Stop");

    await waitFor(() => backend.exportTimes.length > 0, 10_000, "the export Stop flushes");
    // The SDK bounds a flush at 1.5 s, so a reply that waited on the held export lands that late.
    assert.ok(
      stopRepliedAt - backend.exportTimes[0] < 1_000,
      `Stop replied ${stopRepliedAt - backend.exportTimes[0]} ms after the export began`
    );

    backend.releaseExports();
    process.kill(child.pid, "SIGTERM");
    await exited;

    const byName = (name) => backend.exports.filter((s) => s.name === name);
    assert.equal(byName("armoriq.policy.evaluate").length, 1);
    assert.equal(byName("armoriq.tool").length, 1);
    const roots = byName("armoriq.agent.run");
    assert.equal(roots.length, 1, "shutdown ended and shipped the root");
    assert.equal(roots[0].status, "ok", "the session may continue after the daemon exits");
    assert.equal(roots[0].attributes["gen_ai.task.outcome"], "unknown");
    for (const span of backend.exports) {
      assert.equal(span.attributes["armoriq.session_id"], sessionId, span.name);
    }
  } finally {
    killIfRunning(child);
    await backend.close();
  }
});

async function stopDaemon(dataDir) {
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
}

function shape(exports) {
  const stored = storedSpans(exports);
  return {
    traces: new Set(exports.map((s) => s.traceId)).size,
    spans: stored.map((s) => s.name).sort(),
    rootOutcome: exports.filter((s) => s.name === "armoriq.agent.run").at(-1)?.attributes[
      "gen_ai.task.outcome"
    ],
  };
}

test("one session stores the same trace with the daemon up and with it down (#178)", async () => {
  const daemonBackend = await startBackend();
  const fallbackBackend = await startBackend();
  const home = await tempDir("aq-home-");
  const daemonDir = await tempDir("aq-up-");
  const fallbackDir = await tempDir("aq-down-");
  try {
    await runSession(pluginEnv(home, daemonDir, daemonBackend.url), randomUUID());
    assert.ok(existsSync(path.join(daemonDir, "daemon.pid")), "a daemon served these hooks");
    await stopDaemon(daemonDir);

    await withoutDaemon(fallbackDir);
    await runSession(pluginEnv(home, fallbackDir, fallbackBackend.url), randomUUID());

    const up = shape(daemonBackend.exports);
    assert.deepEqual([up.traces, up.spans.length, up.rootOutcome], [1, 5, "completed"]);
    assert.deepEqual(shape(fallbackBackend.exports), up);
  } finally {
    await stopDaemon(daemonDir);
    await daemonBackend.close();
    await fallbackBackend.close();
  }
});

test("a process leaves the root alone once SessionEnd in another process ended it", async () => {
  const backend = await startBackend();
  try {
    const home = await tempDir("aq-home-");
    const dataDir = await tempDir("aq-owner-");
    await withoutDaemon(dataDir);
    const session_id = randomUUID();
    const config = {
      observabilityEnabled: true,
      observabilityEndpoint: backend.url,
      apiKey: API_KEY,
      agentId: "claude-code",
      dataDir,
    };
    await observeHook("SessionStart", { session_id }, null, config);
    const end = await runHook(pluginEnv(home, dataDir, backend.url), {
      session_id,
      hook_event_name: "SessionEnd",
      reason: "other",
    });
    assert.equal(end.code, 0);
    await obsFlush(session_id, config);
    assert.deepEqual(rootOutcomes(backend.exports), ["completed"]);
  } finally {
    await backend.close();
  }
});

test("hook processes ship a call's policy and tool spans under its tool_use_id (#192)", async () => {
  const backend = await startBackend();
  try {
    const home = await tempDir("aq-home-");
    const dataDir = await tempDir("aq-callid-");
    await withoutDaemon(dataDir);
    const env = pluginEnv(home, dataDir, backend.url);
    const session_id = randomUUID();
    const tool = {
      session_id,
      tool_name: "Read",
      tool_input: { file_path: "package.json" },
      tool_use_id: "toolu_01CallIdShip",
    };
    for (const hook_event_name of ["PreToolUse", "PostToolUse", "SessionEnd"]) {
      const { code } = await runHook(env, { ...tool, hook_event_name, tool_response: {} });
      assert.equal(code, 0, hook_event_name);
    }
    const linked = storedSpans(backend.exports)
      .filter((s) => s.attributes["armoriq.tool.call_id"] === tool.tool_use_id)
      .map((s) => s.name)
      .sort();
    assert.deepEqual(linked, ["armoriq.policy.evaluate", "armoriq.tool"]);
  } finally {
    await backend.close();
  }
});

test("the next processes ship the root of a session whose daemon was SIGKILLed, with the connect input", async () => {
  const backend = await startBackend({ content: true });
  const home = await tempDir("aq-home-");
  const dataDir = await tempDir("aq-killed-");
  const env = pluginEnv(home, dataDir, backend.url);
  const daemon = startDaemon(env, dataDir);
  try {
    await waitFor(() => existsSync(daemon.socketPath), 20_000, "the daemon socket");
    const session_id = randomUUID();
    await daemonHook(daemon.socketPath, session_id, "SessionStart");
    const dir = path.join(dataDir, "obs-roots");
    await waitFor(() => existsSync(dir) && readdirSync(dir).length > 0, 10_000, "the marker");
    const marker = JSON.parse(readFileSync(path.join(dir, readdirSync(dir)[0]), "utf8"));
    process.kill(daemon.child.pid, "SIGKILL");
    await daemon.exited;
    await withoutDaemon(dataDir);

    const tool = { session_id, tool_name: "Read", tool_input: { file_path: "a" } };
    for (const hook_event_name of ["PreToolUse", "PostToolUse"]) {
      const { code } = await runHook(env, { ...tool, hook_event_name, tool_response: {} });
      assert.equal(code, 0, hook_event_name);
    }
    const roots = backend.exports.filter((s) => s.name === "armoriq.agent.run");
    assert.deepEqual(rootOutcomes(backend.exports), ["unknown", "unknown"]);
    for (const root of roots) {
      assert.equal(root.startTimeUnixNano / 1_000_000n, BigInt(Date.parse(marker.startTime)));
      assert.match(root.attributes["gen_ai.input.messages"], /ArmorClaude connected/);
    }
    for (const span of backend.exports.filter((s) => s.name !== "armoriq.agent.run")) {
      assert.equal(span.parentSpanId, roots[0].spanId, `${span.name} hangs off the root`);
    }

    await runHook(env, { session_id, hook_event_name: "SessionEnd", reason: "other" });
    assert.deepEqual(rootOutcomes(backend.exports), ["unknown", "unknown", "completed"]);
  } finally {
    killIfRunning(daemon.child);
    await backend.close();
  }
});

test("a second shutdown signal waits for the first shutdown's export", async () => {
  const backend = await startBackend({ holdExports: true });
  const home = await tempDir("aq-home-");
  const dataDir = await tempDir("aq-twice-");
  const daemon = startDaemon(pluginEnv(home, dataDir, backend.url), dataDir);
  try {
    await waitFor(() => existsSync(daemon.socketPath), 20_000, "the daemon socket");
    await daemonHook(daemon.socketPath, randomUUID(), "SessionStart");
    await daemonRequest(daemon.socketPath, { type: "shutdown", reqId: "first" });
    await waitFor(() => backend.exportTimes.length > 0, 10_000, "the shutdown export");
    process.kill(daemon.child.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(daemon.child.exitCode, null, "the daemon exited with its export in flight");
    backend.releaseExports();
    await daemon.exited;
    assert.deepEqual(rootOutcomes(backend.exports), ["unknown"]);
  } finally {
    killIfRunning(daemon.child);
    await backend.close();
  }
});

test("the daemon's SessionEnd export lands although it takes longer than 1.5 s (#190)", async () => {
  const backend = await startBackend({ exportDelayMs: 2_500 });
  const home = await tempDir("aq-home-");
  const dataDir = await tempDir("aq-slow-");
  const daemon = startDaemon(pluginEnv(home, dataDir, backend.url), dataDir);
  try {
    await waitFor(() => existsSync(daemon.socketPath), 20_000, "the daemon socket");
    const sessionId = randomUUID();
    await daemonHook(daemon.socketPath, sessionId, "SessionStart");
    await daemonHook(daemon.socketPath, sessionId, "SessionEnd", { reason: "other" });
    await waitFor(() => backend.delivered.length > 0, 8_000, "the SessionEnd export to land");
    assert.deepEqual(rootOutcomes(backend.delivered), ["completed"]);
  } finally {
    killIfRunning(daemon.child);
    await backend.close();
  }
});

test("an in-process SessionEnd gives up on a hung export within the SDK's 1.5 s bound", async () => {
  const backend = await startBackend({ holdExports: true });
  try {
    const home = await tempDir("aq-home-");
    const dataDir = await tempDir("aq-hung-");
    await withoutDaemon(dataDir);
    const started = Date.now();
    const end = await runHook(pluginEnv(home, dataDir, backend.url), {
      session_id: randomUUID(),
      hook_event_name: "SessionEnd",
      reason: "other",
    });
    assert.equal(end.code, 0);
    assert.ok(backend.exportTimes.length > 0, "the hook started its export");
    assert.ok(Date.now() - started < 3_000, `the hook took ${Date.now() - started} ms`);
  } finally {
    await backend.close();
  }
});

test("a replacement daemon serves hooks while the old one drains its exports (#190)", async () => {
  const backend = await startBackend({ holdExports: true });
  const home = await tempDir("aq-home-");
  const dataDir = await tempDir("aq-swap-");
  const env = pluginEnv(home, dataDir, backend.url);
  const old = startDaemon(env, dataDir);
  let next;
  try {
    await waitFor(() => existsSync(old.socketPath), 20_000, "the first daemon socket");
    await daemonHook(old.socketPath, randomUUID(), "SessionStart");
    await daemonRequest(old.socketPath, { type: "shutdown", reqId: "upgrade" });
    await waitFor(() => backend.exportTimes.length > 0, 10_000, "the draining export");
    next = startDaemon(env, dataDir);
    await waitFor(() => existsSync(next.socketPath), 20_000, "the replacement socket");
    const ping = await daemonRequest(next.socketPath, { type: "ping", reqId: "next" });
    assert.equal(ping.ok, true);
    assert.equal(old.child.exitCode, null, "the old daemon is still draining");
    assert.equal(Number(readFileSync(path.join(dataDir, "daemon.pid"), "utf8")), next.child.pid);
    backend.releaseExports();
    await old.exited;
    assert.ok(existsSync(next.socketPath), "the old daemon left the new socket in place");
  } finally {
    killIfRunning(old.child);
    if (next) killIfRunning(next.child);
    await backend.close();
  }
});
