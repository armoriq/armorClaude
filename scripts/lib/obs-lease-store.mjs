import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writePrivateFile } from "./fs-store.mjs";

export const LEASE_MISS_TTL_MS = 30_000;

export function obsBindingKey(endpoint, apiKey) {
  return createHash("sha256").update(`${endpoint}\n${apiKey}`).digest("hex").slice(0, 32);
}

function leaseFile(dataDir, endpoint, apiKey, extension) {
  return path.join(dataDir, `obs-lease-${obsBindingKey(endpoint, apiKey)}.${extension}`);
}

export function obsLeaseStore(dataDir, endpoint, apiKey) {
  const file = leaseFile(dataDir, endpoint, apiKey, "json");
  const miss = leaseFile(dataDir, endpoint, apiKey, "miss");
  return {
    read: async () => JSON.parse(await readFile(file, "utf8")),
    write: async (lease) => {
      await writePrivateFile(file, JSON.stringify(lease));
      await rm(miss, { force: true });
    },
  };
}

export function obsLeaseMiss(dataDir, endpoint, apiKey) {
  const miss = leaseFile(dataDir, endpoint, apiKey, "miss");
  return {
    async recent(now = Date.now()) {
      const at = Number(await readFile(miss, "utf8").catch(() => NaN));
      return at <= now && now - at < LEASE_MISS_TTL_MS;
    },
    record: () => writePrivateFile(miss, String(Date.now())),
  };
}
