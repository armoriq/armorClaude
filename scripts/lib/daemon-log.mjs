import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { appendPrivateFileSync, writePrivateFileSync } from "./fs-store.mjs";

export const DAEMON_LOG_MAX_BYTES = 1024 * 1024;

export function daemonLogPath(dataDir) {
  return path.join(dataDir, "daemon.log");
}

export function capDaemonLog(logPath, maxBytes = DAEMON_LOG_MAX_BYTES) {
  let size;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size <= maxBytes) return;
  const keep = Math.floor(maxBytes / 2);
  const tail = Buffer.alloc(keep);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, tail, 0, keep, size - keep);
  } finally {
    closeSync(fd);
  }
  const firstLineEnd = tail.indexOf(10);
  writePrivateFileSync(logPath, firstLineEnd === -1 ? tail : tail.subarray(firstLineEnd + 1));
}

export function appendDaemonLog(dataDir, line) {
  const logPath = daemonLogPath(dataDir);
  capDaemonLog(logPath);
  appendPrivateFileSync(logPath, `${line}\n`);
}
