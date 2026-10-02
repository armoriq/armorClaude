import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// sun_path holds 104 bytes on macOS and 108 on Linux; 103 fits both.
export const MAX_SOCKET_PATH_BYTES = 103;

function shortSocketDir() {
  return path.join("/tmp", `armorclaude-${os.userInfo().uid}`);
}

export function daemonSocketPath(dataDir) {
  const inDataDir = path.join(dataDir, "daemon.sock");
  if (Buffer.byteLength(inDataDir) <= MAX_SOCKET_PATH_BYTES) return inDataDir;
  const key = createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
  return path.join(shortSocketDir(), `${key}.sock`);
}

function untrustedReason(dir) {
  const stat = lstatSync(dir);
  const uid = os.userInfo().uid;
  if (!stat.isDirectory()) return "is not a directory";
  if (stat.uid !== uid) return `is owned by uid ${stat.uid}`;
  if ((stat.mode & 0o077) !== 0) return `has mode ${(stat.mode & 0o777).toString(8)}`;
  return null;
}

export function assertTrustedSocketDir(dir) {
  const reason = untrustedReason(dir);
  if (reason) {
    throw new Error(
      `socket directory ${dir} ${reason}; it must be a directory owned by uid ${os.userInfo().uid} with mode 0700`
    );
  }
}

export function prepareSocketDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isDirectory() && stat.uid === os.userInfo().uid && (stat.mode & 0o077) !== 0) {
    chmodSync(dir, 0o700);
  }
  assertTrustedSocketDir(dir);
}

export function prepareDaemonSocketDir(socketPath) {
  const dir = path.dirname(socketPath);
  if (dir === shortSocketDir()) prepareSocketDir(dir);
}

export function assertTrustedSocketPath(socketPath) {
  const dir = path.dirname(socketPath);
  if (dir === shortSocketDir()) assertTrustedSocketDir(dir);
}
