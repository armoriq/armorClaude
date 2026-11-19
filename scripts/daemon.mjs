#!/usr/bin/env node
// Handlers run concurrently; runtime-state writes are serialized per session,
// or simultaneous hooks lose each other's read-modify-write updates.

import { createServer } from "node:net";
import { readFileSync, readdirSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import path from "node:path";
import { REQUEST_CONFIG_KEYS, loadConfig, loginEnforcement } from "./lib/config.mjs";
import { daemonSocketPath, prepareDaemonSocketDir } from "./lib/daemon-socket.mjs";
import { seedBuiltinProfiles } from "./lib/policy-profiles.mjs";
import {
  AUDIT_SIZE_LIMITS,
  LOGIN_TAG,
  auditLoginConfig,
  createAuditWal,
  loginTag,
} from "./lib/audit-wal.mjs";
import { buildAuthHeaders, postJson } from "./lib/common.mjs";
import { ensurePrivateDirSync, writePrivateFileSync } from "./lib/fs-store.mjs";
import { appendDaemonLog, capDaemonLog, daemonLogPath } from "./lib/daemon-log.mjs";
import {
  handleSessionStart,
  handleUserPromptExpansion,
  handleUserPromptSubmit,
  handlePreToolUse,
  handlePostToolUse,
  handlePostToolUseFailure,
  handleStop,
  handleSessionEnd,
} from "./lib/engine.mjs";
import {
  journalHook,
  obsFlushAll,
  obsReleaseIdle,
  obsRetryBacklog,
  obsServeAsDaemon,
} from "./lib/observability.mjs";
import { DAEMON_VERSION } from "./lib/daemon-version.mjs";
import { launchLiveUsage } from "./lib/usage-sync-launch.mjs";
import { sessionOutput } from "./lib/relogin.mjs";
import { startIntentRefreshLoop } from "./lib/intent.mjs";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_LINE_BYTES = AUDIT_SIZE_LIMITS.maxRowBytes + 16 * 1024; // Include the socket envelope around a fitted row.

let config = loadConfig();
ensurePrivateDirSync(config.dataDir);
// Seed built-in profiles eagerly so new templates are available immediately
// after a daemon restart — no lazy first-access required.
await seedBuiltinProfiles(config);

const socketPath = daemonSocketPath(config.dataDir);
prepareDaemonSocketDir(socketPath);
const pidPath = path.join(config.dataDir, "daemon.pid");

function claimPid() {
  if (existsSync(pidPath)) {
    try {
      const existing = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      if (Number.isFinite(existing) && existing !== process.pid) {
        // Is the existing process still alive?
        try {
          process.kill(existing, 0);
          process.stderr.write(
            `[armorclaude-daemon] another daemon is already running (pid=${existing}). Exiting.\n`
          );
          process.exit(0);
        } catch {
          // stale PID file — owner is dead. Take over.
          process.stderr.write(
            `[armorclaude-daemon] cleaning stale PID file (was pid=${existing})\n`
          );
        }
      }
    } catch {
      // unreadable / malformed — overwrite
    }
  }
  writePrivateFileSync(pidPath, String(process.pid));
}

function cleanupSocket() {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* empty */
  }
}

function cleanupPid() {
  try {
    if (existsSync(pidPath)) {
      const owner = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
      if (owner === process.pid) unlinkSync(pidPath);
    }
  } catch {
    /* empty */
  }
}

claimPid();
cleanupSocket();

function requestConfigSignature(cfg) {
  return JSON.stringify(REQUEST_CONFIG_KEYS.map((k) => cfg?.[k] ?? ""));
}

function effectiveConfigFor(configEnv) {
  if (!configEnv || typeof configEnv !== "object") return config;
  if (requestConfigSignature(configEnv) === requestConfigSignature(config)) return config;
  const merged = { ...config };
  merged.signedOut = configEnv.signedOut === true;
  for (const k of REQUEST_CONFIG_KEYS) {
    if (configEnv[k] !== undefined) merged[k] = configEnv[k];
  }
  const localMock = merged.armoriqEnv === "local" && !merged.signedOut;
  Object.assign(merged, loginEnforcement(merged.apiKey, localMock, merged.orgMonitor));
  // verify-step endpoint derives from backendEndpoint; keep it consistent.
  if (configEnv.backendEndpoint) {
    merged.verifyStepEndpoint = `${configEnv.backendEndpoint}/iap/verify-step`;
    merged.csrgEndpoint = config.csrgEndpoint || configEnv.backendEndpoint;
  }
  if (config.debug) {
    const before = config.apiKey ? loginTag(config.backendEndpoint, config.apiKey) : "(unset)";
    const after = merged.apiKey ? loginTag(merged.backendEndpoint, merged.apiKey) : "(unset)";
    process.stderr.write(
      `[daemon] per-request config overlay: key id ${before} -> ${after} obsEnabled=${merged.observabilityEnabled}\n`
    );
  }
  return merged;
}

// All hooks for the same session_id execute in order, even if they arrive
// concurrently from multiple connections, so runtime-state.json read/write
// stays atomic. Different sessions run independently (in parallel).
const sessionLocks = new Map();
function withSessionLock(sessionId, fn) {
  if (!sessionId) return fn(); // no lock needed if there's no session
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  const result = prev.then(() => fn());
  const next = result.catch(() => null);
  sessionLocks.set(sessionId, next);
  next.finally(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  });
  return result;
}

const AUDIT_FLUSH_INTERVAL_MS = 5_000;
const logins = new Map();

function loginWal(tag, binding, stream = "audit") {
  const key = `${stream}:${tag}`;
  if (!logins.has(key) || (binding && !logins.get(key).binding))
    logins.set(key, {
      binding,
      stream,
      wal: createAuditWal({ dataDir: config.dataDir, login: tag, binding, stream }),
    });
  return logins.get(key);
}

async function trackLogin(cfg) {
  if (!cfg.apiKey || cfg.signedOut) return;
  const tag = loginTag(cfg.backendEndpoint, cfg.apiKey);
  for (const stream of cfg.auditEnabled ? ["audit", "health"] : ["health"]) {
    const entry = loginWal(tag, { backend: cfg.backendEndpoint, keyId: tag }, stream);
    await restoreAuditLogin(entry, cfg);
  }
}

async function restoreAuditLogin(entry, cfg) {
  const revision = cfg.loggedInAt || "";
  if (entry.revision === revision) return;
  await entry.wal.restoreLogin(revision);
  entry.revision = revision;
}

function adoptAuditDir() {
  for (const stream of ["audit", "health"]) {
    const root = path.join(config.dataDir, stream);
    if (!existsSync(root)) continue;
    try {
      for (const name of readdirSync(root)) {
        if (LOGIN_TAG.test(name)) loginWal(name, undefined, stream);
      }
    } catch {
      process.stderr.write(`[daemon] ${stream} outbox discovery failed\n`);
    }
  }
}

async function flushAudit(reason) {
  adoptAuditDir();
  await flushEntries(
    [...logins.values()].filter((entry) => entry.stream !== "health"),
    reason
  );
  adoptAuditDir();
  await flushEntries(
    [...logins.values()].filter((entry) => entry.stream === "health"),
    reason
  );
}

function requestFlush(reason) {
  void flushAudit(reason).catch(() => {
    process.stderr.write(`[daemon] outbox flush failed reason=${reason}\n`);
  });
}

async function flushEntries(entries, reason) {
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.flush) entry.flushAgain = true;
      entry.flush ??= (async () => {
        do {
          entry.flushAgain = false;
          await shipLogin(entry);
        } while (entry.flushAgain);
      })().finally(() => {
        entry.flush = null;
      });
      try {
        await entry.flush;
      } catch (error) {
        process.stderr.write(
          `[daemon] audit WAL flush failed reason=${reason}: ${error.message}\n`
        );
      }
    })
  );
}

async function shipLogin(entry) {
  const binding = entry.binding || (await entry.wal.readBinding());
  if (!binding) return;
  const cfg = auditLoginConfig(binding, loadConfig());
  if (!entry.binding) {
    entry.binding = binding;
    entry.wal = createAuditWal({
      dataDir: config.dataDir,
      login: binding.keyId,
      binding,
      stream: entry.stream,
    });
  }
  const resolveLogin = () => (auditLoginConfig(binding, loadConfig()) ? binding : null);
  if (cfg) {
    await restoreAuditLogin(entry, cfg);
    await entry.wal.drain(
      async ({ rows }) => {
        const current = auditLoginConfig(binding, loadConfig());
        if (!current) return { status: 401, body: {} };
        const response = await postJson(
          `${binding.backend}${entry.stream === "health" ? "/iap/client-events" : "/iap/audit/batch"}`,
          entry.stream === "health" ? { events: rows } : { rows },
          buildAuthHeaders(current),
          current.timeoutMs || 8000
        );
        return {
          status: response.status,
          body: response.data,
          headers: response.headers,
          ...(response.status === 403 && response.data?.error === "org_required"
            ? { hold: "org_required" }
            : {}),
        };
      },
      {
        resolveLogin,
        probe: async () => {
          const current = auditLoginConfig(binding, loadConfig());
          if (!current) return { status: 401 };
          return postJson(
            `${binding.backend}/iap/validate-key`,
            {},
            buildAuthHeaders(current),
            current.timeoutMs || 8000
          );
        },
      }
    );
  }
  await entry.wal.reportHealth(undefined, { resolveLogin });
  await entry.wal.pruneArchive();
}

adoptAuditDir();
await trackLogin(config);

async function enqueueAudit(dto, login, binding, fallback) {
  if (
    !dto ||
    typeof dto !== "object" ||
    !LOGIN_TAG.test(login ?? "") ||
    (binding && binding.keyId !== login)
  )
    throw new Error("Invalid audit capture envelope");
  const { wal } = loginWal(login, binding);
  await wal.appendLine(dto, { fallback });
  return wal;
}

const auditTimer = setInterval(() => {
  requestFlush("interval");
}, AUDIT_FLUSH_INTERVAL_MS);
auditTimer.unref();
const stopIntentRefresh = startIntentRefreshLoop(() => loadConfig());

// `cfg` is the per-request effective config snapshot (see effectiveConfigFor)
// so enforcement + audit gating never read a module-global that a concurrent
// session mutated between enqueue and execution.
async function dispatchHook(event, input, cfg) {
  switch (event) {
    case "SessionStart":
      return handleSessionStart(input, cfg);
    case "UserPromptExpansion":
      return handleUserPromptExpansion(input, cfg);
    case "UserPromptSubmit":
      return handleUserPromptSubmit(input, cfg);
    case "PreToolUse":
      return handlePreToolUse(input, cfg);
    case "PostToolUse":
      return handlePostToolUse(input, cfg);
    case "PostToolUseFailure":
      return handlePostToolUseFailure(input, cfg);
    case "Stop": {
      const out = await handleStop(input, cfg);
      // Stage turn-end rows before returning, then deliver without holding the session lock.
      requestFlush("stop");
      return out;
    }
    case "SessionEnd": {
      const out = await handleSessionEnd(input, cfg);
      requestFlush("session_end");
      return out;
    }
    default:
      throw new Error(`unknown event: ${event}`);
  }
}

function syncUsageAfter(event, cfg, input) {
  if (event === "Stop") launchLiveUsage(cfg, input);
}

let lastActivity = Date.now();
const idleTimer = setInterval(() => {
  try {
    capDaemonLog(daemonLogPath(config.dataDir));
  } catch (err) {
    process.stderr.write(`[armorclaude-daemon] daemon.log cap failed: ${err?.message ?? err}\n`);
  }
  obsReleaseIdle(IDLE_TIMEOUT_MS);
  obsRetryBacklog();
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    process.stderr.write(
      `[armorclaude-daemon] idle for ${IDLE_TIMEOUT_MS / 60_000} min, exiting pid=${process.pid} at=${new Date().toISOString()}\n`
    );
    shutdown(0);
  }
}, 60_000);
idleTimer.unref();

function bumpActivity() {
  lastActivity = Date.now();
}

const server = createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    if (buf.length > MAX_LINE_BYTES * 4) {
      // Pathological: client is dumping huge lines. Close to protect us.
      socket.destroy(new Error("payload too large"));
      return;
    }
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > MAX_LINE_BYTES) {
        socket.write(JSON.stringify({ error: "line too large" }) + "\n");
        continue;
      }
      handleLine(line, socket).catch((err) => {
        try {
          socket.write(JSON.stringify({ error: err?.message ?? String(err) }) + "\n");
        } catch {
          /* empty */
        }
      });
    }
  });
  socket.on("error", () => {
    /* clients come and go; ignore */
  });
});

async function handleLine(rawLine, socket) {
  bumpActivity();
  if (!rawLine.trim()) return;
  let msg;
  try {
    msg = JSON.parse(rawLine);
  } catch {
    socket.write(JSON.stringify({ error: "invalid JSON" }) + "\n");
    return;
  }
  const reqId = typeof msg?.reqId === "string" ? msg.reqId : null;
  switch (msg?.type) {
    case "ping": {
      socket.write(
        JSON.stringify({ reqId, ok: true, version: DAEMON_VERSION, uptime: process.uptime() }) +
          "\n"
      );
      return;
    }
    case "audit_enqueue": {
      // Replying before fsync would let a hook exit with its only audit row still in memory.
      try {
        const wal = await enqueueAudit(msg.dto, msg.login, msg.binding, msg.fallback);
        socket.write(JSON.stringify({ reqId, ok: true, durable: true }) + "\n");
        void wal
          .pendingBytes()
          .then((size) => {
            if (size > AUDIT_SIZE_LIMITS.maxBatchBytes) return flushAudit("threshold");
          })
          .catch((error) => {
            process.stderr.write(`[daemon] audit threshold check failed: ${error.message}\n`);
          });
      } catch (err) {
        socket.write(JSON.stringify({ reqId, ok: false, error: "Audit capture failed" }) + "\n");
        process.stderr.write(`[daemon] enqueueAudit failed: ${err?.message ?? err}\n`);
      }
      return;
    }
    case "shutdown": {
      socket.write(JSON.stringify({ reqId, ok: true, shuttingDown: true }) + "\n");
      shutdown(0);
      return;
    }
    case "hook": {
      const event = String(msg.event || "");
      const input = msg.input ?? {};
      const sessionId = typeof input.session_id === "string" ? input.session_id : "";
      const effectiveConfig = effectiveConfigFor(msg.configEnv);
      await trackLogin(effectiveConfig);
      let output;
      try {
        output = await withSessionLock(sessionId, async () =>
          sessionOutput(
            event,
            input,
            effectiveConfig,
            await dispatchHook(event, input, effectiveConfig)
          )
        );
      } catch (err) {
        const message = err?.message ?? String(err);
        appendDaemonLog(
          config.dataDir,
          `[armorclaude-daemon] ${event} handler failed session=${sessionId} at=${new Date().toISOString()}: ${err?.stack ?? message}`
        );
        socket.write(JSON.stringify({ reqId, handlerError: message }) + "\n");
        return;
      }
      await journalHook(event, input, output, effectiveConfig);
      socket.write(JSON.stringify({ reqId, output }) + "\n");
      syncUsageAfter(event, effectiveConfig, input);
      return;
    }
    default: {
      socket.write(JSON.stringify({ reqId, error: `unknown type: ${msg?.type}` }) + "\n");
    }
  }
}

server.on("error", (err) => {
  process.stderr.write(`[armorclaude-daemon] server error: ${err?.message ?? err}\n`);
  if (!server.listening) shutdown(1);
});

await obsServeAsDaemon(config);
server.listen(socketPath, () => {
  // 0600 so only this user can connect (defense in depth — Unix sockets
  // already inherit dir perms, but we set explicitly).
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    /* best-effort */
  }
  process.stderr.write(
    `[armorclaude-daemon] listening on ${socketPath} pid=${process.pid} version=${DAEMON_VERSION} at=${new Date().toISOString()}\n`
  );
});

let stopping = null;
function shutdown(code) {
  stopping ??= stopAndExit(code);
  return stopping;
}

async function stopAndExit(code) {
  stopIntentRefresh();
  server.close();
  await flushAudit("shutdown").catch(() => undefined);
  cleanupSocket();
  cleanupPid();
  await obsFlushAll();
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
// SIGHUP re-reads the login profile without restarting the daemon.
process.on("SIGHUP", async () => {
  try {
    const fresh = loadConfig();
    const before = config.apiKey ? loginTag(config.backendEndpoint, config.apiKey) : "(unset)";
    const after = fresh.apiKey ? loginTag(fresh.backendEndpoint, fresh.apiKey) : "(unset)";
    config = fresh;
    await trackLogin(fresh);
    process.stderr.write(
      `[armorclaude-daemon] SIGHUP: config reloaded. key id: ${before} -> ${after}\n`
    );
  } catch (err) {
    process.stderr.write(`[armorclaude-daemon] SIGHUP reload failed: ${err?.message ?? err}\n`);
  }
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[armorclaude-daemon] uncaught: ${err?.stack ?? err}\n`);
  shutdown(1);
});
