import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
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

const isOwnedAndShared = (st) => (st.mode & 0o077) !== 0 && st.uid === process.getuid?.();

export async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (isOwnedAndShared(await stat(dir))) await chmod(dir, PRIVATE_DIR_MODE);
}

export function ensurePrivateDirSync(dir) {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (isOwnedAndShared(statSync(dir))) chmodSync(dir, PRIVATE_DIR_MODE);
}

const tightenedDirs = new Set();

export async function tightenDirFilesOnce(dir) {
  if (tightenedDirs.has(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isFile() && isOwnedAndShared(await stat(file))) await chmod(file, PRIVATE_FILE_MODE);
  }
  tightenedDirs.add(dir);
}

// Atomic write: write to a sibling tmp file then rename into place. Prevents
// partial/torn JSON when two hooks (PreToolUse + PostToolUse) race or when the
// process is killed mid-write.
export async function writePrivateFile(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
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

export function openPrivateSync(filePath, flags) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIR_MODE });
  const fd = openSync(filePath, flags, PRIVATE_FILE_MODE);
  try {
    if (isOwnedAndShared(fstatSync(fd))) fchmodSync(fd, PRIVATE_FILE_MODE);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return fd;
}

function writeAllSync(filePath, flags, data) {
  const fd = openPrivateSync(filePath, flags);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

export const writePrivateFileSync = (filePath, data) => writeAllSync(filePath, "w", data);

export const appendPrivateFileSync = (filePath, data) => writeAllSync(filePath, "a", data);
