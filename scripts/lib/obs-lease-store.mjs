import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writePrivateFile } from "./fs-store.mjs";

const LEASE_MISS_TTL_MS = 30_000;

function leaseFile(dataDir, endpoint, apiKey, extension) {
  const key = createHash("sha256").update(`${endpoint}\n${apiKey}`).digest("hex").slice(0, 32);
  return path.join(dataDir, `obs-lease-${key}.${extension}`);
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

async function leaseCurrent(file, now) {
  const lease = await readFile(file, "utf8").then(JSON.parse, () => null);
  return Date.parse(lease?.expiresAt) > now;
}

export function obsLeaseMiss(dataDir, endpoint, apiKey) {
  const file = leaseFile(dataDir, endpoint, apiKey, "json");
  const miss = leaseFile(dataDir, endpoint, apiKey, "miss");
  return {
    async recent(now = Date.now()) {
      if (await leaseCurrent(file, now)) return false;
      const at = Number(await readFile(miss, "utf8").catch(() => NaN));
      return at <= now && now - at < LEASE_MISS_TTL_MS;
    },
    record: () => writePrivateFile(miss, String(Date.now())),
  };
}
