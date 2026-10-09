import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import armoriqSdk from "@armoriq/sdk-dev";
import { loadConfig } from "../../scripts/lib/config.mjs";

const { profileName } = armoriqSdk;

export const STAGING = "https://staging-api.armoriq.ai";
export const GOLDEN_CREDENTIALS = new URL("../fixtures/golden-credentials.json", import.meta.url);

function credentialsFile(home) {
  const file = path.join(home, ".armoriq", "credentials.json");
  assert.ok(path.resolve(file).startsWith(path.resolve(os.tmpdir()) + path.sep), file);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return file;
}

export function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "armorclaude-home-"));
}

export function writeLoginProfiles(home, entries) {
  const file = credentialsFile(home);
  const doc = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { version: 2, active: null, profiles: {}, historyOrigin: "fresh", loginHistory: {} };
  const { profiles } = doc;
  for (const {
    backend,
    product = "armorclaude",
    apiKey,
    orgId = "org-login",
    userId = "user-login",
    loggedInAt = "2026-10-08T12:00:00.000Z",
  } of entries) {
    const name = profileName(backend, product);
    profiles[name] = {
      backend: new URL(backend).origin,
      product,
      apiKey,
      email: "dev@example.com",
      userId,
      orgId,
      loggedInAt,
      savedAt: loggedInAt,
    };
    doc.loginHistory[name] = {
      id: randomUUID(),
      origin: "fresh",
      events: [{ sequence: 1, at: loggedInAt, userId }],
    };
  }
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  return home;
}

export function copyGoldenCredentials(home) {
  copyFileSync(GOLDEN_CREDENTIALS, credentialsFile(home));
  return home;
}

export function withHome(home, fn) {
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(os.homedir(), home);
    return fn();
  } finally {
    process.env.HOME = saved;
  }
}

export function loadConfigWithLogins(entries, env = {}) {
  return withHome(writeLoginProfiles(tempHome(), entries), () => loadConfig(env));
}
