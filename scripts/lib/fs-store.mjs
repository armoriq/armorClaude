import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  mkdirSync,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export async function readJson(filePath, fallbackValue) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return fallbackValue;
    }
    // Corrupted JSON (e.g. interrupted write from an older non-atomic build)
    // falls back to the default rather than breaking the whole session.
    if (error instanceof SyntaxError) {
      return fallbackValue;
    }
    throw error;
  }
}

export const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

const opensToOthers = (st, mode) => (st.mode & 0o777) !== mode && st.uid === process.getuid?.();

export async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (opensToOthers(await stat(dir), PRIVATE_DIR_MODE)) await chmod(dir, PRIVATE_DIR_MODE);
}

export function ensurePrivateDirSync(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (opensToOthers(statSync(dir), PRIVATE_DIR_MODE)) chmodSync(dir, PRIVATE_DIR_MODE);
}

export async function tightenPrivateFile(filePath) {
  try {
    if (opensToOthers(await stat(filePath), PRIVATE_FILE_MODE)) {
      await chmod(filePath, PRIVATE_FILE_MODE);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

// Atomic write: write to a sibling tmp file then rename into place. Prevents
// partial/torn JSON when two hooks (PreToolUse + PostToolUse) race or when the
// process is killed mid-write.
export async function writePrivateFile(filePath, text) {
  await ensurePrivateDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tmpPath, text, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await writePrivateFile(filePath, JSON.stringify(value, null, 2));
}

export async function appendPrivateFile(filePath, text) {
  await ensurePrivateDir(path.dirname(filePath));
  const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY;
  const handle = await open(filePath, flags, PRIVATE_FILE_MODE);
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.write(text, null, "utf8");
  } finally {
    await handle.close();
  }
}

export function openPrivateSync(filePath, flags) {
  ensurePrivateDirSync(path.dirname(filePath));
  const fd = openSync(filePath, flags, PRIVATE_FILE_MODE);
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

export function writePrivateFileSync(filePath, text) {
  const fd = openPrivateSync(filePath, "w");
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
