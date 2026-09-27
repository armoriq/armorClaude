import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
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

export function prepareDaemonSocketDir(socketPath) {
  const dir = path.dirname(socketPath);
  if (dir !== shortSocketDir()) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  const uid = os.userInfo().uid;
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error(
      `socket directory ${dir} must be a directory owned by uid ${uid} with mode 0700`
    );
  }
}
