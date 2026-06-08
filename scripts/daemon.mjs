#!/usr/bin/env node
/**
 * armorclaude-daemon — Phase 4 Tier B
 *
 * Long-running Node process listening on a Unix domain socket. Hooks become
 * thin clients (scripts/lib/daemon-client.mjs) that send a JSON line per
 * event and read the decision back. This eliminates the per-hook fresh-node
 * spawn (~80-150 ms) and the per-hook SDK init (~50 ms), and lets us own
 * the audit-batch lifecycle without forcing the hook to wait on HTTP.
 *
 * Protocol (newline-delimited JSON over the socket):
 *   client → daemon:  {"type":"hook","event":"PreToolUse","input":{...},"reqId":"…"}
 *   daemon → client:  {"reqId":"…","output":<hook output JSON or null>}
 *   client → daemon:  {"type":"audit_enqueue","dto":{…},"reqId":"…"}     (fire and forget; no reply)
 *   client → daemon:  {"type":"ping","reqId":"…"}
 *   daemon → client:  {"reqId":"…","ok":true,"version":"…","uptime":…}
 *   client → daemon:  {"type":"shutdown","reqId":"…"}
 *
 * Concurrency: every connection runs handlers concurrently; runtime-state
 * persistence is serialized through a per-session promise chain so atomic
 * read-modify-write semantics hold across simultaneous hooks.
 *
 * Lifecycle: PID file at ${dataDir}/daemon.pid claims ownership at startup;
 * exits if another daemon is already running. Idle-exits after 30 minutes
 * of no requests so we don't leak processes when Claude Code closes.
 *
 * Crash mode: if any handler throws, daemon logs to stderr and continues
 * serving other connections. Persistent state (runtime-state.json, audit
 * buffer) is flushed to disk before exit on SIGTERM/SIGINT.
 */

import { createServer } from "node:net";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./lib/config.mjs";
import { createAuditWal } from "./lib/audit-wal.mjs";
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

const DAEMON_VERSION = "0.2.17";
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const MAX_LINE_BYTES = 256 * 1024; // 256 KB per JSON message

let config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const socketPath = path.join(config.dataDir, "daemon.sock");
const pidPath = path.join(config.dataDir, "daemon.pid");

// ---- PID file: claim ownership or refuse to start ------------------------
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
  writeFileSync(pidPath, String(process.pid), "utf8");
}

// ---- Socket cleanup ------------------------------------------------------
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

// ---- Per-session serialization ------------------------------------------
// All hooks for the same session_id execute in order, even if they arrive
// concurrently from multiple connections, so runtime-state.json read/write
// stays atomic. Different sessions run independently (in parallel).
const sessionLocks = new Map();
function withSessionLock(sessionId, fn) {
  if (!sessionId) return fn(); // no lock needed if there's no session
  const prev = sessionLocks.get(sessionId) || Promise.resolve();
  const next = prev
    .then(() => fn())
    .catch((err) => {
      process.stderr.write(
        `[armorclaude-daemon] session ${sessionId} handler failed: ${err?.message ?? err}\n`
      );
      return null;
    });
  sessionLocks.set(sessionId, next);
  // Drop the lock entry once it settles so the map doesn't grow forever.
  next.finally(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  });
  return next;
}

// ---- Audit log (Tier C2 + WAL durability) -------------------------------
// Rows are appended to a local JSONL file on disk before the caller is
// acknowledged. A background tick reads from the WAL, ships up to 100 rows
// per batch, then advances the shipped offset. This makes audit crash-safe:
// SIGKILL between disk write and backend ack loses zero rows because the
// rows are on disk before we ack the hook.
//
// In-memory `auditBuffer` is retained as a back-compat fallback when WAL is
// disabled (ARMORCLAUDE_AUDIT_WAL=false). Today's tests assert behavior
// against either path.
const auditWal = config.auditWal ? createAuditWal({ dataDir: config.dataDir }) : null;
const auditBuffer = [];
const AUDIT_FLUSH_INTERVAL_MS = 5_000;
const AUDIT_FLUSH_THRESHOLD = 100;
let auditFlushInFlight = false;

async function flushAudit(reason) {
  if (auditFlushInFlight) return;
  if (!config.auditEnabled || !config.apiKey) {
    // No backend to ship to. Don't truncate the WAL — rotation handles
    // unbounded growth at 10 MB / 1 h. Earlier code aggressively advanced
    // the offset which destroyed crash-recovery if audit was later enabled.
    auditBuffer.length = 0;
    return;
  }

  auditFlushInFlight = true;
  try {
    const { createIapService } = await import("./lib/iap-service.mjs");
    const iap = createIapService(config);

    if (auditWal) {
      // WAL path: read up to 100 rows from disk, ship, advance offset.
      // Loop until pending is empty or we hit a transient failure.
      while (true) {
        const { rows, endOffset } = await auditWal.readBatch(AUDIT_FLUSH_THRESHOLD);
        if (rows.length === 0) break;
        try {
          if (typeof iap.createAuditLogBatch === "function") {
            await iap.createAuditLogBatch(rows);
          } else {
            for (const dto of rows) {
              await iap.createAuditLog(dto).catch((e) => {
                if (config.debug)
                  process.stderr.write(`[daemon] audit row failed: ${e?.message ?? e}\n`);
              });
            }
          }
          await auditWal.advanceOffset(endOffset);
          if (config.debug) {
            process.stderr.write(
              `[daemon] audit WAL flushed size=${rows.length} reason=${reason}\n`
            );
          }
        } catch (err) {
          // Don't advance the offset — next tick replays from same position.
          if (config.debug) {
            process.stderr.write(
              `[daemon] audit WAL flush failed reason=${reason} err=${err?.message ?? err}\n`
            );
          }
          break;
        }
      }
      // Prune archived segments older than the retention cap (default 5).
      try {
        await auditWal.pruneArchive();
      } catch {
        /* empty */
      }
      return;
    }

    // Legacy in-memory path: kept for back-compat when auditWal=false.
    if (auditBuffer.length === 0) return;
    const batch = auditBuffer.splice(0, auditBuffer.length);
    try {
      if (typeof iap.createAuditLogBatch === "function") {
        await iap.createAuditLogBatch(batch);
      } else {
        for (const dto of batch) {
          await iap.createAuditLog(dto).catch((e) => {
            if (config.debug)
              process.stderr.write(`[daemon] audit row failed: ${e?.message ?? e}\n`);
          });
        }
      }
      if (config.debug) {
        process.stderr.write(`[daemon] audit flush ok size=${batch.length} reason=${reason}\n`);
      }
    } catch (err) {
      if (auditBuffer.length + batch.length <= 10_000) {
        auditBuffer.unshift(...batch);
      }
      if (config.debug) {
        process.stderr.write(
          `[daemon] audit flush failed reason=${reason} err=${err?.message ?? err}\n`
        );
      }
    }
  } finally {
    auditFlushInFlight = false;
  }
}

async function enqueueAudit(dto) {
  if (!dto || typeof dto !== "object") return;
  // Skip persistence entirely when audit shipping is disabled. The hook
  // would just be writing rows to disk that no flush will ever pick up.
  if (!config.auditEnabled) return;
  if (auditWal) {
    try {
      await auditWal.appendLine(dto);
      const pending = await auditWal.pendingBytes();
      // Heuristic: kick a flush early if the WAL has grown past ~100KB
      // (roughly 100-200 rows). Avoids waiting the full 5s tick.
      if (pending > 100_000) flushAudit("threshold");
    } catch (err) {
      // Disk-full or row-too-large: fall back to in-memory so we don't
      // silently drop the row. This is best-effort — caller is fire-and-forget.
      if (config.debug) {
        process.stderr.write(
          `[daemon] audit WAL append failed (falling back to memory): ${err?.message ?? err}\n`
        );
      }
      auditBuffer.push(dto);
    }
    return;
  }
  // Legacy path
  auditBuffer.push(dto);
  if (auditBuffer.length >= AUDIT_FLUSH_THRESHOLD) {
    flushAudit("threshold");
  }
}

const auditTimer = setInterval(() => {
  flushAudit("interval");
}, AUDIT_FLUSH_INTERVAL_MS);
auditTimer.unref();

// ---- Hook dispatch -------------------------------------------------------
async function dispatchHook(event, input) {
  switch (event) {
    case "SessionStart":
      return handleSessionStart(input, config);
    case "UserPromptExpansion":
      return handleUserPromptExpansion(input, config);
    case "UserPromptSubmit":
      return handleUserPromptSubmit(input, config);
    case "PreToolUse":
      return handlePreToolUse(input, config);
    case "PostToolUse":
      return handlePostToolUse(input, config);
    case "PostToolUseFailure":
      return handlePostToolUseFailure(input, config);
    case "Stop": {
      const out = await handleStop(input, config);
      // Flush audits on turn end so each turn's row count lands together.
      await flushAudit("stop");
      return out;
    }
    case "SessionEnd": {
      const out = await handleSessionEnd(input, config);
      await flushAudit("session_end");
      return out;
    }
    default:
      throw new Error(`unknown event: ${event}`);
  }
}

// ---- Idle timeout --------------------------------------------------------
let lastActivity = Date.now();
const idleTimer = setInterval(() => {
  if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
    if (config.debug) process.stderr.write("[daemon] idle timeout, exiting\n");
    shutdown(0);
  }
}, 60_000);
idleTimer.unref();

function bumpActivity() {
  lastActivity = Date.now();
}

// ---- Server -------------------------------------------------------------
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
      // Fire-and-forget at the *protocol* level (no reply), but we await
      // the WAL write so the disk record is durable before the daemon
      // moves on. Without the await a crash between read and write loses
      // the audit row even though the WAL exists for exactly this reason.
      try {
        await enqueueAudit(msg.dto);
      } catch (err) {
        if (config.debug)
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
      const output = await withSessionLock(sessionId, () => dispatchHook(event, input));
      socket.write(JSON.stringify({ reqId, output }) + "\n");
      return;
    }
    default: {
      socket.write(JSON.stringify({ reqId, error: `unknown type: ${msg?.type}` }) + "\n");
    }
  }
}

server.on("error", (err) => {
  process.stderr.write(`[armorclaude-daemon] server error: ${err?.message ?? err}\n`);
});

server.listen(socketPath, () => {
  // 0600 so only this user can connect (defense in depth — Unix sockets
  // already inherit dir perms, but we set explicitly).
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    /* best-effort */
  }
  if (config.debug)
    process.stderr.write(`[armorclaude-daemon] listening on ${socketPath} pid=${process.pid}\n`);
});

// ---- Shutdown handlers ---------------------------------------------------
function shutdown(code) {
  // Try to flush audits one last time. If we can't await (sync context), at
  // least kick the flush; the process will linger briefly.
  flushAudit("shutdown").finally(() => {
    try {
      server.close();
    } catch {
      /* empty */
    }
    cleanupSocket();
    cleanupPid();
    process.exit(code);
  });
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
// SIGHUP — operator signals "config / creds changed, reload yourself".
// Re-reads launchctl env + ~/.armoriq/credentials.json via loadConfig().
// The engine's invalidateTokenOnKeyChange detects per-session token drift
// independently, so this signal is rarely needed — but it's the right
// idiomatic knob for ops who want to force a reload without restarting
// the daemon.
process.on("SIGHUP", () => {
  try {
    const fresh = loadConfig();
    const before = config.apiKey ? config.apiKey.slice(0, 16) : "(unset)";
    const after = fresh.apiKey ? fresh.apiKey.slice(0, 16) : "(unset)";
    config = fresh;
    process.stderr.write(
      `[armorclaude-daemon] SIGHUP: config reloaded. apiKey prefix: ${before} -> ${after}\n`
    );
  } catch (err) {
    process.stderr.write(`[armorclaude-daemon] SIGHUP reload failed: ${err?.message ?? err}\n`);
  }
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`[armorclaude-daemon] uncaught: ${err?.stack ?? err}\n`);
  shutdown(1);
});
