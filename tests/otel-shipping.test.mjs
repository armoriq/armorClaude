// Spans shipped over OTLP to a local backend by real hook and daemon processes (#157).
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = Number(varint());
      fields.push({ no, bytes: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error(`unsupported wire type ${wire}`);
  }
  return fields;
}

const sub = (buf, no) => protoFields(buf).filter((f) => f.no === no && f.bytes);

// ExportTraceServiceRequest -> ResourceSpans(1) -> ScopeSpans(2) -> Span(2): name(5), attributes(9)
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
        spans.push({ name, attributes });
      }
    }
  }
  return spans;
}

async function startBackend({ holdExports = false } = {}) {
  const exports = [];
  const exportTimes = [];
  const heldExports = [];
  const lease = () =>
    JSON.stringify({
      captureMode: "metadata",
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
        exports.push(...decodeSpans(Buffer.concat(chunks)));
        const answer = () => {
          res.writeHead(200, { "content-type": "application/x-protobuf" });
          res.end();
        };
        if (holdExports) heldExports.push(answer);
        else answer();
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

test("fallback PreToolUse and PostToolUse, one process each, ship spans carrying the session id", async () => {
  const backend = await startBackend();
  try {
    const home = await tempDir("aq-home-");
    const dataDir = await tempDir("aq-fallback-");
    // The daemon exits on startup when profiles is a file, so each hook runs in-process.
    await writeFile(path.join(dataDir, "profiles"), "not a directory");
    const env = pluginEnv(home, dataDir, backend.url);
    const sessionId = randomUUID();
    const tool = { session_id: sessionId, tool_name: "Bash", tool_input: { command: "ls" } };

    const pre = await runHook(env, { ...tool, hook_event_name: "PreToolUse" });
    const post = await runHook(env, {
      ...tool,
      hook_event_name: "PostToolUse",
      tool_response: { stdout: "a\n" },
    });
    assert.equal(pre.code, 0);
    assert.equal(post.code, 0);
    assert.ok(!existsSync(path.join(dataDir, "daemon.sock")), "no daemon served these hooks");

    const policy = backend.exports.filter((s) => s.name === "armoriq.policy.evaluate");
    const toolSpans = backend.exports.filter((s) => s.name === "armoriq.tool");
    assert.equal(policy.length, 1, "the PreToolUse process shipped its policy span");
    assert.equal(toolSpans.length, 1, "the PostToolUse process shipped its tool span");
    for (const span of [...policy, ...toolSpans]) {
      assert.equal(span.attributes["armoriq.session_id"], sessionId, span.name);
    }
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

test("daemon replies to Stop without waiting on the span export, and its shutdown ships the open root", async () => {
  const backend = await startBackend({ holdExports: true });
  const home = await tempDir("aq-home-");
  const dataDir = await tempDir("aq-daemon-");
  const child = spawn(process.execPath, [daemonScript], {
    env: pluginEnv(home, dataDir, backend.url),
    stdio: "ignore",
    cwd: dataDir,
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const socketPath = path.join(dataDir, "daemon.sock");
    await waitFor(() => existsSync(socketPath), 20_000, "the daemon socket");
    const sessionId = randomUUID();
    const hook = async (event, input = {}) => {
      const reply = await daemonRequest(socketPath, {
        type: "hook",
        reqId: event,
        event,
        input: { session_id: sessionId, hook_event_name: event, ...input },
      });
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
    assert.equal(byName("armoriq.agent.run").length, 1, "shutdown ended and shipped the root");
    for (const span of backend.exports) {
      assert.equal(span.attributes["armoriq.session_id"], sessionId, span.name);
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, "SIGKILL");
    await backend.close();
  }
});
