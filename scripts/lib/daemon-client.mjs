/**
 * Phase 4 Tier B — daemon socket client.
 *
 * Used by hook-router.mjs as a fast path: connect to the local daemon over
 * Unix socket, send the hook event as one JSON line, await one JSON line of
 * response. Falls back to in-process handling on any error so the plugin
 * never breaks if the daemon is missing/broken.
 *
 * Round-trip target: <5 ms p50, <20 ms p95 (vs 30-350 ms in-process).
 *
 * Audit DTOs go via fire-and-forget audit_enqueue messages — daemon batches
 * and flushes asynchronously, hook process exits immediately.
 */

import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONNECT_TIMEOUT_MS = 1_500; // give up fast — we want to fall back if daemon is hung
const REPLY_TIMEOUT_MS = 10_000; // reply may include a backend call (token mint, audit ship)
const SPAWN_RETRY_DELAY_MS = 150;
const SPAWN_RETRIES = 3;
const EXPECTED_DAEMON_VERSION = "0.2.18";

let nextReqId = 1;
function makeReqId() {
  return `r-${process.pid}-${nextReqId++}-${Date.now()}`;
}

/**
 * Connect to the daemon socket. Returns a connected socket or rejects on
 * timeout / ECONNREFUSED / ENOENT (socket file missing).
 */
function connectOnce(socketPath) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("daemon connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Spawn the daemon as a detached child and return once it accepts a
 * connection (up to SPAWN_RETRIES × SPAWN_RETRY_DELAY_MS).
 */
async function spawnDaemon(socketPath, dataDir, config) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const daemonScript = path.resolve(here, "..", "daemon.mjs");
  // Pass the resolved dataDir explicitly so the spawned daemon writes its
  // socket + PID file to the same place the client expects, even if the
  // parent process was started with a different ARMORCLAUDE_DATA_DIR.
  const childEnv = {
    ...process.env,
    ARMORCLAUDE_DATA_DIR: dataDir,
    ARMORCLAUDE_RUNTIME_FILE: config?.runtimeFile || path.join(dataDir, "runtime.json"),
    ARMORCLAUDE_POLICY_FILE: config?.policyFile || path.join(dataDir, "policy.json"),
  };
  mkdirSync(dataDir, { recursive: true });
  const nodeBin = existsSync(process.execPath) ? process.execPath : "node";
  const child = spawn(nodeBin, [daemonScript], {
    detached: true,
    stdio: "ignore",
    cwd: dataDir,
    env: childEnv,
  });
  let spawnError = null;
  child.once("error", (err) => {
    spawnError = err;
  });
  child.unref();

  for (let i = 0; i < SPAWN_RETRIES; i++) {
    if (spawnError) throw spawnError;
    await new Promise((r) => setTimeout(r, SPAWN_RETRY_DELAY_MS));
    if (spawnError) throw spawnError;
    if (existsSync(socketPath)) {
      try {
        const sock = await connectOnce(socketPath);
        return sock;
      } catch {
        /* try again */
      }
    }
  }
  throw new Error("daemon spawn did not become reachable");
}

async function shutdownDaemon(socketPath) {
  let sock;
  try {
    sock = await connectOnce(socketPath);
    await exchange(sock, { type: "shutdown", reqId: makeReqId() });
  } catch {
    // Best effort. If shutdown fails, the next connect/spawn path falls back
    // to in-process hook handling instead of silently trusting stale code.
  } finally {
    try {
      sock?.end();
    } catch {
      /* noop */
    }
    try {
      sock?.destroy();
    } catch {
      /* noop */
    }
  }
}

async function ensureFreshDaemonSocket(socketPath, config) {
  let sock;
  try {
    sock = await connectOnce(socketPath);
  } catch (err) {
    if (err?.code === "ENOENT" || err?.code === "ECONNREFUSED") {
      return spawnDaemon(socketPath, config.dataDir, config);
    }
    throw err;
  }

  try {
    const ping = await exchange(sock, { type: "ping", reqId: makeReqId() });
    if (ping?.version === EXPECTED_DAEMON_VERSION) {
      return sock;
    }
  } catch {
    // Treat an unpingable daemon as stale/unhealthy and replace it below.
  }

  try {
    sock.end();
  } catch {
    /* noop */
  }
  try {
    sock.destroy();
  } catch {
    /* noop */
  }
  await shutdownDaemon(socketPath);
  return spawnDaemon(socketPath, config.dataDir, config);
}

/**
 * Send one request, read one reply. Returns the parsed JSON or throws.
 */
function exchange(sock, payload) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        cleanup();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (err) {
          reject(err);
        }
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      sock.off("data", onData);
      sock.off("error", onError);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("daemon reply timeout"));
    }, REPLY_TIMEOUT_MS);
    sock.on("data", onData);
    sock.on("error", onError);
    sock.write(JSON.stringify(payload) + "\n");
  });
}

/**
 * Public entry: dispatch a hook event through the daemon.
 *
 * @param {object} args
 * @param {string} args.event           hook_event_name
 * @param {object} args.input           full hook payload (matches handler signature)
 * @param {object} args.config          loaded config (for socket path resolution)
 * @returns {Promise<object|null>}      hook output JSON, or null
 *
 * Throws if the daemon is unreachable. Caller (hook-router.mjs) is expected
 * to fall back to in-process dispatch on throw.
 */
export async function dispatchViaDaemon({ event, input, config }) {
  const socketPath = path.join(config.dataDir, "daemon.sock");
  const debug = !!config?.debug;
  const t0 = debug ? Date.now() : 0;
  const sock = await ensureFreshDaemonSocket(socketPath, config);
  const tConnected = debug ? Date.now() : 0;
  try {
    const reqId = makeReqId();
    // Forward the obs/auth-relevant slice of THIS hook's freshly-loaded config
    // so the long-lived daemon can serve observability + backend calls with the
    // live session's credentials, even if the daemon was first spawned by an
    // env-poor hook (the zero-traces root cause). The daemon merges this per
    // request and refreshes its cached config when the signature changes.
    const configEnv = config
      ? {
          armoriqEnv: config.armoriqEnv,
          apiKey: config.apiKey,
          orgId: config.orgId,
          backendEndpoint: config.backendEndpoint,
          observabilityEnabled: config.observabilityEnabled,
          observabilityEndpoint: config.observabilityEndpoint,
          observabilityProduct: config.observabilityProduct,
          auditEnabled: config.auditEnabled,
          csrgVerifyEnabled: config.csrgVerifyEnabled,
          cryptoPolicyEnabled: config.cryptoPolicyEnabled,
        }
      : undefined;
    const reply = await exchange(sock, { type: "hook", event, input, reqId, configEnv });
    if (debug) {
      const tDone = Date.now();
      process.stderr.write(
        `[armorclaude] daemon dispatch event=${event} reqId=${reqId} connect=${tConnected - t0}ms total=${tDone - t0}ms\n`
      );
    }
    if (reply?.error) throw new Error(`daemon error: ${reply.error}`);
    return reply?.output ?? null;
  } finally {
    try {
      sock.end();
    } catch {
      /* empty */
    }
    try {
      sock.destroy();
    } catch {
      /* empty */
    }
  }
}

/**
 * Fire-and-forget audit enqueue. Returns immediately after the write
 * completes (microseconds), does not wait for any reply. If the daemon is
 * unreachable, returns false and the caller should fall back to a sync
 * createAuditLog.
 */
export async function enqueueAuditViaDaemon({ dto, config }) {
  const socketPath = path.join(config.dataDir, "daemon.sock");
  let sock;
  try {
    sock = await connectOnce(socketPath);
  } catch {
    return false;
  }
  try {
    sock.write(JSON.stringify({ type: "audit_enqueue", dto, reqId: makeReqId() }) + "\n");
    return true;
  } catch {
    return false;
  } finally {
    try {
      sock.end();
    } catch {
      /* empty */
    }
    try {
      sock.destroy();
    } catch {
      /* empty */
    }
  }
}

/** Liveness probe — used by daemon-supervisor and tests. */
export async function pingDaemon(config) {
  const socketPath = path.join(config.dataDir, "daemon.sock");
  let sock;
  try {
    sock = await connectOnce(socketPath);
  } catch {
    return null;
  }
  try {
    const reply = await exchange(sock, { type: "ping", reqId: makeReqId() });
    return reply;
  } finally {
    try {
      sock.end();
    } catch {
      /* empty */
    }
    try {
      sock.destroy();
    } catch {
      /* empty */
    }
  }
}
