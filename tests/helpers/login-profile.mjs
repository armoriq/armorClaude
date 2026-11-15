import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRODUCTION = "https://api.armoriq.ai";
export const STAGING = "https://staging-api.armoriq.ai";

export function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "armorclaude-home-"));
}

export function withHome(home, fn) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
}

export function writeLoginProfiles(home, entries) {
  const dir = path.join(home, ".armoriq");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const profiles = {};
  for (const { backend, product = "armorclaude", apiKey, orgId = "org-test" } of entries) {
    profiles[`${product}@${new URL(backend).host}`] = {
      backend: new URL(backend).origin,
      product,
      apiKey,
      orgId,
    };
  }
  writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ version: 2, profiles }), {
    mode: 0o600,
  });
}
