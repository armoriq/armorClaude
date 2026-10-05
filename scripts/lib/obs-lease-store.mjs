import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writePrivateFile } from "./fs-store.mjs";

export function obsLeaseStore(dataDir, endpoint, apiKey) {
  const key = createHash("sha256").update(`${endpoint}\n${apiKey}`).digest("hex").slice(0, 32);
  const file = path.join(dataDir, `obs-lease-${key}.json`);
  return {
    read: async () => JSON.parse(await readFile(file, "utf8")),
    write: (lease) => writePrivateFile(file, JSON.stringify(lease)),
  };
}
