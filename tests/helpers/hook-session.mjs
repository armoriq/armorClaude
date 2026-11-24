import { fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import armoriqSdk from "@armoriq/sdk";
import { updateRuntimeState } from "../../scripts/lib/runtime-state.mjs";
import { writeLoginProfiles } from "./login-profile.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const daemonScript = path.join(repoRoot, "scripts", "daemon.mjs");
const hookParents = new WeakMap();
let claudeRunner;
let installedPlugin;
export const API_KEY = "ak_test_hooksession000000000000000000";

export async function installedPluginRoot() {
  installedPlugin ??= mkdtemp(path.join(os.tmpdir(), "aq-hook-plugin-")).then(async (dir) => {
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    const scripts = path.join(dir, "scripts");
    await mkdir(scripts);
    await copyFile(
      path.join(repoRoot, "scripts/bootstrap.mjs"),
      path.join(scripts, "bootstrap.mjs")
    );
    // A copied handler changes DAEMON_VERSION, so hooks replace the managed daemon and leak its replacement.
    for (const entry of await readdir(path.join(repoRoot, "scripts"), { withFileTypes: true })) {
      if (entry.name === "bootstrap.mjs") continue;
      await symlink(
        path.join(repoRoot, "scripts", entry.name),
        path.join(scripts, entry.name),
        entry.isDirectory() ? "dir" : "file"
      );
    }
    await copyFile(path.join(repoRoot, "package.json"), path.join(dir, "package.json"));
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    for (const name of Object.keys(pkg.dependencies)) {
      const target = path.join(dir, "node_modules", name);
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(path.join(repoRoot, "node_modules", name), target, "dir");
    }
    await writeFile(path.join(dir, "node_modules", ".armorclaude-installed"), pkg.version);
    return dir;
  });
  return installedPlugin;
}

// One copy per test process, removed when the process exits; a node:test after() hook would bind to
// whichever test first asked for it and delete the copy while later tests still fork it.
export function claudeExecutable() {
  claudeRunner ??= mkdtemp(path.join(os.tmpdir(), "aq-claude-runner-")).then(async (dir) => {
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    const executable = path.join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    await copyFile(process.execPath, executable);
    return executable;
  });
  return claudeRunner;
}

export function mockTokenBackend(t, handler) {
  const requests = [];
  const original = armoriqSdk.ArmorIQClient.prototype.createHttpClient;
  t.mock.method(armoriqSdk.ArmorIQClient.prototype, "createHttpClient", function (...args) {
    const client = original.apply(this, args);
    client.defaults.adapter = async (request) => {
      const outgoing = {
        body: JSON.parse(request.data),
        headers: request.headers.toJSON(),
        timeout: request.timeout,
      };
      requests.push(outgoing);
      const [status, data, headers = {}] = await handler(outgoing, requests.length);
      return { status, data, headers, config: request, statusText: String(status) };
    };
    return client;
  });
  return requests;
}

export async function waitFor(predicate, ms, what) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function withTimeout(promise, what, ms = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startBackend(routes = {}) {
  const requests = [];
  const auditRows = [];
  const waiters = new Set();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : null;
      const route = `${req.method} ${req.url}`;
      requests.push({
        route,
        body,
        headers: req.headers,
        client: req.headers["x-armoriq-client"],
        monitorAware: req.headers["x-armoriq-monitor-aware"],
      });
      for (const waiter of waiters) {
        const request = requests.at(-1);
        if (request.route === waiter.route && waiter.matches(request.body)) {
          waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(request.body);
        }
      }
      if (route === "POST /iap/audit/batch") {
        auditRows.push(...body.rows);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ written: body.rows.length, failures: [] }));
        return;
      }
      const handler = routes[route] ?? routes[`${req.method} ${req.url.split("?")[0]}`];
      const [status, reply, headers = {}] =
        (await handler?.(body, req)) ??
        (route.startsWith("GET /policy/bundles/current")
          ? [200, { orgId: "org-test", agents: [] }]
          : [404, {}]);
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(reply));
    });
  });
  await withTimeout(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    "test backend listen"
  );
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    auditRows,
    waitForRequest: (route, matches = () => true, what = "matching request", ms = 10_000) => {
      const received = requests.find((request) => request.route === route && matches(request.body));
      return received
        ? Promise.resolve(received.body)
        : new Promise((resolve, reject) => {
            const waiter = { route, matches, resolve, reject };
            waiter.timer = setTimeout(() => {
              waiters.delete(waiter);
              reject(new Error(`timed out waiting for ${route}: ${what}`));
            }, ms);
            waiters.add(waiter);
          });
    },
    close: () =>
      new Promise((resolve) => {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`backend closed waiting for ${waiter.route}`));
        }
        waiters.clear();
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export async function startPolicyMcp(t, env, sessionId) {
  const parent = hookParents.get(env);
  if (parent) return parent.mcp();
  await updateRuntimeState(path.join(env.CLAUDE_PLUGIN_DATA, "runtime.json"), (state) => {
    state.sessions[sessionId].claudeProcessId = process.pid;
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(await installedPluginRoot(), "scripts/bootstrap.mjs"), "mcp"],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "contract-test", version: "1" });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

async function startClaudeParent(t, env) {
  const executable = await claudeExecutable();
  const parent = fork(
    new URL("./claude-parent.mjs", import.meta.url),
    [await installedPluginRoot()],
    {
      execPath: executable,
      execArgv: [],
      env,
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }
  );
  const pending = new Map();
  let nextId = 0;
  let client;
  let connection;
  const request = (type, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for Claude test parent: ${type}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      parent.send({ id, type, ...params }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  const transport = {
    start: () => request("mcp-start"),
    send: (message) => request("mcp-send", { message }),
    close: () => request("mcp-close"),
  };
  parent.on("message", ({ id, type, message, result, error }) => {
    if (type === "mcp-message") return transport.onmessage?.(message);
    if (type === "mcp-error") return transport.onerror?.(new Error(error));
    if (type === "mcp-close") return transport.onclose?.();
    const waiter = pending.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(id);
    if (error) waiter.reject(new Error(error));
    else waiter.resolve(result);
  });
  const fail = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    transport.onclose?.();
  };
  parent.on("error", fail);
  const exited = new Promise((resolve) => {
    parent.once("exit", (code, signal) => {
      fail(new Error(`Claude test parent exited (${code ?? signal})`));
      resolve();
    });
  });
  t.after(async () => {
    try {
      if (client) await client.close();
    } finally {
      if (parent.connected) parent.disconnect();
      try {
        await withTimeout(exited, "Claude test parent exit");
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
      }
    }
  });
  return {
    hook: (payload) => request("hook", { payload }),
    mcp: () => {
      if (!connection) {
        client = new Client({ name: "contract-test", version: "1" });
        connection = client.connect(transport).then(() => client);
      }
      return connection;
    },
  };
}

export async function startHookSession(t, backend, extraEnv = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "aq-hook-home-"));
  const dataDir =
    extraEnv.CLAUDE_PLUGIN_DATA ?? (await mkdtemp(path.join(os.tmpdir(), "aq-hook-data-")));
  writeLoginProfiles(home, [{ backend: backend.url, apiKey: API_KEY }]);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    ARMORIQ_ENV: "local",
    ARMORIQ_ORG_MODE: "enforce",
    ARMORIQ_BACKEND_URL: backend.url,
    ARMORIQ_CSRG_URL: backend.url,
    ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
    ...extraEnv,
  };
  const daemon = spawn(process.execPath, [daemonScript], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
    cwd: dataDir,
  });
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    daemon.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.includes("[armorclaude-daemon] listening on ")) resolve();
    });
    daemon.once("error", reject);
    daemon.once("exit", (code, signal) =>
      reject(new Error(`Daemon exited before ready (${code ?? signal}): ${stderr}`))
    );
  });
  const exited = new Promise((resolve) => daemon.once("exit", resolve));
  t.after(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    await exited;
    await backend.close();
  });
  await withTimeout(ready, "daemon readiness");
  const sessionId = randomUUID();
  const parent = await startClaudeParent(t, env);
  hookParents.set(env, parent);
  const hook = (payload) => parent.hook({ session_id: sessionId, ...payload });
  return {
    env,
    dataDir,
    sessionId,
    hook,
    shutdown: async () => {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
      await withTimeout(exited, "daemon shutdown");
    },
  };
}
