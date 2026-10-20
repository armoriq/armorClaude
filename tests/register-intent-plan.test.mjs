import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { daemonSocketPath, prepareDaemonSocketDir } from "../scripts/lib/daemon-socket.mjs";
import * as daemonVersion from "../scripts/lib/daemon-version.mjs";
import { savePolicyState } from "../scripts/lib/policy.mjs";
import { API_KEY, startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";
import { writeLoginProfiles } from "./helpers/login-profile.mjs";

const policyMcp = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "policy-mcp.mjs"
);

const POLICY = {
  schemaVersion: "armor.policy.v1",
  kind: "PolicyProfile",
  metadata: { name: "enforcing", description: "" },
  defaults: { decision: "allow", conflictResolution: "deny_overrides" },
  statements: [
    {
      id: "forbid-webfetch",
      effect: "forbid",
      principal: { type: "agent", id: "claude-code" },
      action: { type: "tool", eq: "WebFetch" },
      resource: { type: "workspace", scope: "current" },
      conditions: [],
    },
  ],
};

const tokenReply = (planId) => () => [
  200,
  {
    success: true,
    plan_id: planId,
    plan_hash: "plan-hash",
    intent_reference: "intent-ref",
    token: { issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
    step_proofs: [],
  },
];

const READ_PLAN = {
  goal: "read the readme",
  steps: [{ action: "Read", description: "read README.md" }],
};

async function daemonlessEnv(t, backend) {
  const home = await mkdtemp(path.join(os.tmpdir(), "aq-mcp-home-"));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aq-mcp-data-"));
  writeLoginProfiles(home, [{ backend: backend.url, apiKey: API_KEY }]);
  t.after(async () => {
    const pidFile = path.join(dataDir, "daemon.pid");
    if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    await backend.close();
  });
  const sessionId = randomUUID();
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_PLUGIN_DATA: dataDir,
    CLAUDE_CODE_SESSION_ID: sessionId,
    ARMORIQ_ENV: "local",
    ARMORIQ_BACKEND_URL: backend.url,
    ARMORIQ_CSRG_URL: backend.url,
  };
  return { env, dataDir, sessionId };
}

async function fakeDaemon(t, dataDir, answer) {
  const socketPath = daemonSocketPath(dataDir);
  prepareDaemonSocketDir(socketPath);
  const seen = [];
  const server = createServer((sock) => {
    let buf = "";
    sock.on("error", () => {});
    sock.on("data", (chunk) => {
      buf += chunk;
      for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        seen.push(msg.type);
        sock.write(`${JSON.stringify({ reqId: msg.reqId, ...answer(msg) })}\n`);
        if (msg.type === "shutdown" && server.listening) server.close();
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.listening && server.close());
  return seen;
}

function daemonRequest(dataDir, message) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(daemonSocketPath(dataDir));
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk;
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

function storedSession(dataDir, sessionId) {
  const runtimeFile = path.join(dataDir, "runtime.json");
  if (!existsSync(runtimeFile)) return undefined;
  return JSON.parse(readFileSync(runtimeFile, "utf8")).sessions?.[sessionId];
}

const storedPlanId = (dataDir, sessionId) => {
  const tokenRaw = storedSession(dataDir, sessionId)?.intentTokenRaw;
  return tokenRaw ? JSON.parse(tokenRaw).planId : undefined;
};

function writePriorPlan(dataDir, sessionId) {
  const priorToken = { tokenId: "prior", planId: randomUUID(), planHash: "prior-hash" };
  writeFileSync(
    path.join(dataDir, "runtime.json"),
    JSON.stringify({
      sessions: {
        [sessionId]: {
          intentTokenRaw: JSON.stringify(priorToken),
          plan: { goal: "list files", steps: [{ action: "Bash" }] },
          updatedAt: Math.floor(Date.now() / 1000),
        },
      },
    })
  );
}

const reanchorReply = () => [
  200,
  { trustId: "trust-1", delta: { payload: { from_hash: "prior-hash", to_hash: "plan-hash" } } },
];

async function registerIntentPlan(t, env, args) {
  const client = new Client({ name: "register-intent-plan-test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [policyMcp],
      env,
      stderr: "ignore",
    })
  );
  t.after(() => client.close());
  const result = await client.callTool({ name: "register_intent_plan", arguments: args });
  return result.content[0].text;
}

async function enforcedSession(t, planId) {
  const backend = await startBackend({ "POST /iap/sdk/token": tokenReply(planId) });
  const session = await startHookSession(t, backend);
  await savePolicyState(path.join(session.dataDir, "policy.json"), { version: 1, policy: POLICY });
  await session.hook({ hook_event_name: "SessionStart", source: "startup" });
  await session.hook({ hook_event_name: "UserPromptSubmit", prompt: "read the readme" });
  return { ...session, backend };
}

test("the first Read after register_intent_plan is audited against the registered plan", async (t) => {
  const planId = randomUUID();
  const { backend, env, sessionId, hook } = await enforcedSession(t, planId);
  const reply = await registerIntentPlan(t, env, {
    goal: "read the readme",
    steps: [{ action: "Read", description: "read README.md" }],
  });
  assert.match(reply, /^Intent registered: 1 steps/);

  const read = { tool_name: "Read", tool_input: { file_path: "/repo/README.md" } };
  assert.equal(await hook({ hook_event_name: "PreToolUse", ...read }), null);
  await hook({ hook_event_name: "PostToolUse", ...read, tool_response: { content: "readme" } });
  await hook({ hook_event_name: "Stop" });

  await waitFor(() => backend.auditRows.length > 0, 15_000, "the Read audit row");
  assert.deepEqual(
    backend.auditRows.map((row) => [row.tool, row.status, row.plan_id, row.session_id]),
    [["Read", "success", planId, sessionId]]
  );
});

test("register_intent_plan with no active session stores nothing and asks for a prompt first", async (t) => {
  const backend = await startBackend({ "POST /iap/sdk/token": tokenReply(randomUUID()) });
  const { env, dataDir } = await startHookSession(t, backend);
  const reply = await registerIntentPlan(t, env, {
    goal: "read the readme",
    steps: [{ action: "Read", description: "read README.md" }],
  });
  assert.match(reply, /^Plan rejected: no active ArmorClaude session/);
  assert.deepEqual(
    readdirSync(dataDir).filter((name) => /plan|runtime/.test(name)),
    []
  );
  assert.deepEqual(
    backend.requests.filter((r) => r.route === "POST /iap/sdk/token"),
    []
  );
});

test("a running daemon that predates register_plan is replaced before the plan is stored", async (t) => {
  const planId = randomUUID();
  const backend = await startBackend({ "POST /iap/sdk/token": tokenReply(planId) });
  const { env, dataDir, sessionId } = await daemonlessEnv(t, backend);
  const seen = await fakeDaemon(t, dataDir, (msg) => {
    if (msg.type === "ping") return { ok: true, version: daemonVersion.DAEMON_VERSION };
    if (msg.type === "shutdown") return { ok: true, shuttingDown: true };
    return { error: `unknown type: ${msg.type}` };
  });
  assert.match(await registerIntentPlan(t, env, READ_PLAN), /^Intent registered: 1 steps/);
  assert.deepEqual(seen, ["ping", "shutdown"]);
  assert.equal(storedPlanId(dataDir, sessionId), planId);
});

test("register_intent_plan stores nothing itself when a live daemon fails the write", async (t) => {
  const backend = await startBackend({ "POST /iap/sdk/token": tokenReply(randomUUID()) });
  const { env, dataDir, sessionId } = await daemonlessEnv(t, backend);
  const seen = await fakeDaemon(t, dataDir, (msg) =>
    msg.type === "ping"
      ? {
          ok: true,
          version: daemonVersion.DAEMON_VERSION,
          protocol: daemonVersion.DAEMON_PROTOCOL,
        }
      : { error: "register_plan failed" }
  );
  assert.match(await registerIntentPlan(t, env, READ_PLAN), /register_plan failed/);
  assert.deepEqual(seen, ["ping", "register_plan"]);
  assert.equal(storedSession(dataDir, sessionId), undefined);
});

test("register_intent_plan stores the plan in-process when no daemon can start and daemon.log is unwritable", async (t) => {
  const planId = randomUUID();
  const backend = await startBackend({ "POST /iap/sdk/token": tokenReply(planId) });
  const { env, dataDir, sessionId } = await daemonlessEnv(t, backend);
  mkdirSync(path.join(dataDir, "daemon.log"));
  assert.match(await registerIntentPlan(t, env, READ_PLAN), /^Intent registered: 1 steps/);
  assert.equal(storedPlanId(dataDir, sessionId), planId);
});

test("the daemon stores a registration without calling the backend", async (t) => {
  const backend = await startBackend({ "POST /iap/trust/reanchor": reanchorReply });
  const { dataDir, sessionId } = await startHookSession(t, backend);
  writePriorPlan(dataDir, sessionId);
  const plan = { goal: "read the readme", steps: [{ action: "Read" }] };
  const reply = await daemonRequest(dataDir, {
    type: "register_plan",
    reqId: "r1",
    registration: { sessionId, plan, tokenRaw: "", allowedActions: ["read"], policyHash: "h" },
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(storedSession(dataDir, sessionId).plan, plan);
  assert.deepEqual(
    backend.requests.map((r) => r.route),
    []
  );
});

test("registering a changed plan sends one ReAnchor and records it in the session", async (t) => {
  const planId = randomUUID();
  const backend = await startBackend({
    "POST /iap/sdk/token": tokenReply(planId),
    "POST /iap/trust/reanchor": reanchorReply,
  });
  const { env, dataDir, sessionId } = await startHookSession(t, backend);
  writePriorPlan(dataDir, sessionId);
  await registerIntentPlan(t, { ...env, CLAUDE_CODE_SESSION_ID: sessionId }, READ_PLAN);
  assert.equal(backend.requests.filter((r) => r.route === "POST /iap/trust/reanchor").length, 1);
  const session = storedSession(dataDir, sessionId);
  assert.equal(JSON.parse(session.intentTokenRaw).planId, planId);
  assert.deepEqual(
    session.trustOpsLog.map((op) => [op.operation, op.trustId, op.fromHash, op.toHash, op.ok]),
    [["ReAnchor", "trust-1", "prior-hash", "plan-hash", true]]
  );
});
