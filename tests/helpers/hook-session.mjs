import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeLoginProfiles } from "./login-profile.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hookRouter = path.join(repoRoot, "scripts", "hook-router.mjs");
const daemonScript = path.join(repoRoot, "scripts", "daemon.mjs");
const API_KEY = "ak_test_hooksession000000000000000000";

export async function waitFor(predicate, ms, what) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function startBackend(routes = {}) {
  const requests = [];
  const auditRows = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) : null;
      const route = `${req.method} ${req.url}`;
      requests.push({ route, body });
      if (route === "POST /iap/audit/batch") {
        auditRows.push(...body.rows);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ written: body.rows.length, failures: [] }));
        return;
      }
      const [status, reply] = routes[route]?.(body) ?? [404, {}];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    auditRows,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

export async function startHookSession(t, backend) {
  const home = await mkdtemp(path.join(os.tmpdir(), "aq-hook-home-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aq-hook-data-"));
  writeLoginProfiles(home, [{ backend: backend.url, apiKey: API_KEY }]);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    ARMORIQ_ENV: "local",
    ARMORIQ_BACKEND_URL: backend.url,
    ARMORIQ_CSRG_URL: backend.url,
    ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}),
  };
  const daemon = spawn(process.execPath, [daemonScript], { env, stdio: "ignore", cwd: dataDir });
  const exited = new Promise((resolve) => daemon.once("exit", resolve));
  t.after(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGKILL");
    await exited;
    await backend.close();
  });
  await waitFor(() => existsSync(path.join(dataDir, "daemon.sock")), 10_000, "the daemon socket");
  const sessionId = randomUUID();
  const hook = (payload) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookRouter], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code !== 0) reject(new Error(`${payload.hook_event_name} exited ${code}`));
        else resolve(stdout.trim() ? JSON.parse(stdout) : null);
      });
      child.stdin.end(JSON.stringify({ session_id: sessionId, ...payload }));
    });
  return { env, dataDir, sessionId, hook };
}
