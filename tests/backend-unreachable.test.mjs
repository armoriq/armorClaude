import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { loginTag } from "../scripts/lib/audit-wal.mjs";
import { capabilityOf } from "../scripts/lib/backend-posture.mjs";
import { API_KEY, startHookSession, waitFor } from "./helpers/hook-session.mjs";

// A backend that answers normally, never answers ("stall"), answers 503, or
// rejects the key with 401, switchable mid-session.
async function switchableBackend() {
  const requests = [];
  const auditRows = [];
  const stalled = new Set();
  const backend = { mode: "up", requests, auditRows };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const route = `${req.method} ${req.url}`;
      requests.push(route);
      if (backend.mode === "stall") return stalled.add(res);
      const reply = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (backend.mode === "503") return reply(503, { message: "down" });
      if (backend.mode === "401") return reply(401, { message: "Invalid or expired API key" });
      if (route.startsWith("GET /policy/bundles/current"))
        return reply(200, { orgId: "o", agents: [] });
      if (route === "POST /iap/audit/batch") {
        const { rows } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        auditRows.push(...rows);
        return reply(200, { written: rows.length, failures: [] });
      }
      reply(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  backend.url = `http://127.0.0.1:${server.address().port}`;
  backend.recover = () => {
    backend.mode = "up";
    for (const res of stalled) res.destroy();
    stalled.clear();
  };
  backend.close = () =>
    new Promise((resolve) => {
      for (const res of stalled) res.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return backend;
}

const decisionOf = (output) => output?.hookSpecificOutput?.permissionDecision ?? "allow";
const reasonOf = (output) => output?.hookSpecificOutput?.permissionDecisionReason ?? "";

function queuedRows(dataDir, backend) {
  const wal = path.join(dataDir, "audit", loginTag(backend.url, API_KEY), "current.jsonl");
  if (!existsSync(wal)) return [];
  return readFileSync(wal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function timed(fn) {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

test("capability follows the published table", () => {
  for (const [tool, capability] of [
    ["Read", "read"],
    ["Glob", "read"],
    ["Grep", "read"],
    ["LS", "read"],
    ["NotebookRead", "read"],
    ["Write", "write"],
    ["Edit", "write"],
    ["MultiEdit", "write"],
    ["NotebookEdit", "write"],
    ["Bash", "shell"],
    ["mcp__github__get_issue", "mcp"],
    ["mcp__plugin_x_server__read_file", "mcp"],
    ["WebFetch", "web"],
    ["WebSearch", "web"],
    ["Task", "other"],
    ["Skill", "other"],
  ]) {
    assert.equal(capabilityOf(tool), capability, tool);
  }
});

test("a backend that stops answering blocks Write after the 2 second timeout, blocks MCP, runs Read, and ships the queued rows once it is back", async (t) => {
  const backend = await switchableBackend();
  const { hook, dataDir } = await startHookSession(t, backend);
  const pre = (tool_name, tool_input) =>
    hook({ hook_event_name: "PreToolUse", tool_name, tool_input });
  backend.mode = "stall";

  const write = await timed(() => pre("Write", { file_path: "/tmp/x.txt", content: "x" }));
  assert.equal(decisionOf(write.value), "deny", JSON.stringify(write.value));
  assert.match(reasonOf(write.value), /backend_unreachable/);
  assert.match(reasonOf(write.value), / status/);
  assert.ok(write.ms >= 1900 && write.ms < 6000, `Write took ${write.ms} ms`);

  const read = await timed(() => pre("Read", { file_path: "/tmp/x.txt" }));
  assert.equal(decisionOf(read.value), "allow", JSON.stringify(read.value));
  assert.ok(read.ms < 1900, `Read waited ${read.ms} ms on a backend already known down`);

  const mcp = await timed(() => pre("mcp__github__get_issue", { number: 1 }));
  assert.equal(decisionOf(mcp.value), "deny", JSON.stringify(mcp.value));
  assert.match(reasonOf(mcp.value), /backend_unreachable/);
  assert.ok(mcp.ms < 1900, `MCP waited ${mcp.ms} ms on a backend already known down`);

  await waitFor(() => queuedRows(dataDir, backend).length === 2, 5_000, "two queued rows");
  const queued = queuedRows(dataDir, backend);
  assert.deepEqual(
    queued.map((r) => [r.tool, r.capability, r.status, r.error_message]),
    [
      ["Write", "write", "blocked", "backend_unreachable"],
      ["mcp__github__get_issue", "mcp", "blocked", "backend_unreachable"],
    ]
  );
  assert.equal(backend.auditRows.length, 0);

  backend.recover();
  await waitFor(() => backend.auditRows.length === 2, 30_000, "the queued rows to upload");
  assert.deepEqual(
    backend.auditRows.map((r) => [r.tool, r.capability, r.error_message]),
    queued.map((r) => [r.tool, r.capability, r.error_message])
  );
});

test("a 5xx marks the backend unreachable without waiting out the timeout", async (t) => {
  const backend = await switchableBackend();
  const { hook } = await startHookSession(t, backend);
  const bash = () =>
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });

  backend.mode = "503";
  const failed = await timed(bash);
  assert.equal(decisionOf(failed.value), "deny", JSON.stringify(failed.value));
  assert.match(reasonOf(failed.value), /backend_unreachable/);
  assert.ok(failed.ms < 1900, `a 503 took ${failed.ms} ms`);
});

test("a backend nobody listens on blocks Bash with backend_unreachable and lets Read run", async (t) => {
  const backend = await switchableBackend();
  const { hook } = await startHookSession(t, backend);
  await backend.close();
  const pre = (tool_name, tool_input) =>
    hook({ hook_event_name: "PreToolUse", tool_name, tool_input });

  const read = await pre("Read", { file_path: "/tmp/x.txt" });
  assert.equal(decisionOf(read), "allow", JSON.stringify(read));
  const bash = await pre("Bash", { command: "ls" });
  assert.equal(decisionOf(bash), "deny", JSON.stringify(bash));
  assert.match(reasonOf(bash), /backend_unreachable/);
});

test("a 401 signs the plugin out instead of marking the backend unreachable", async (t) => {
  const backend = await switchableBackend();
  const { hook, dataDir } = await startHookSession(t, backend);
  const bash = () =>
    hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });

  backend.mode = "401";
  const first = await bash();
  assert.doesNotMatch(reasonOf(first), /backend_unreachable/);
  assert.equal(decisionOf(first), "allow", JSON.stringify(first));

  const sent = backend.requests.length;
  const second = await bash();
  assert.equal(decisionOf(second), "allow", JSON.stringify(second));
  const start = await hook({ hook_event_name: "SessionStart", source: "startup" });
  assert.match(JSON.stringify(start), /No ArmorClaude login/);
  assert.deepEqual(
    backend.requests.slice(sent),
    [],
    "a signed-out plugin still called the backend"
  );
  assert.deepEqual(queuedRows(dataDir, backend), []);
});
