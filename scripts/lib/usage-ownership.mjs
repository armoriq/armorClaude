import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildAuthHeaders, postJson } from "./common.mjs";
import { ensurePrivateDirSync, PRIVATE_FILE_MODE, readJson, writeJson } from "./fs-store.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);

export const backendOrigin = (config) => new URL(config.backendEndpoint).origin;

/** Stable id of the config's API key on its backend; the key itself is never stored. */
export const keyIdOf = (config) => digest(`${backendOrigin(config)}\n${config.apiKey}`);

const usageSyncDir = (dataDir) => path.join(dataDir, "usage-sync");
const ownerPath = (dataDir, transcript) =>
  path.join(usageSyncDir(dataDir), "owners", `${digest(path.resolve(transcript))}.json`);

export const keyBase = (dataDir, keyId) => path.join(usageSyncDir(dataDir), "keys", keyId);

export const scopeIdOf = (backend, orgId) => digest(`${backend}\n${orgId}`);

export const scopeStatePath = (dataDir, scopeId) =>
  path.join(usageSyncDir(dataDir), "scopes", scopeId, "state.json");

function createClaim(file, claim) {
  ensurePrivateDirSync(path.dirname(file));
  try {
    writeFileSync(file, JSON.stringify(claim), { flag: "wx", mode: PRIVATE_FILE_MODE });
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

function cachedOrg(dataDir, keyId) {
  try {
    const { orgId } = JSON.parse(readFileSync(`${keyBase(dataDir, keyId)}.json`, "utf8"));
    return typeof orgId === "string" && orgId ? { org: orgId } : {};
  } catch {
    return {};
  }
}

function hasUsage(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return err?.code !== "ENOENT";
  }
  return raw.split("\n").some((line) => {
    try {
      const obj = JSON.parse(line);
      return Boolean(obj?.message?.usage ?? obj?.usage);
    } catch {
      return false;
    }
  });
}

const isNewSession = ({ session_id: id, source, transcript_path: file } = {}) =>
  SESSION_ID.test(String(id)) &&
  (source === "startup" || source === "clear") &&
  typeof file === "string" &&
  path.basename(file) === `${id}.jsonl` &&
  !hasUsage(file);

/**
 * Give a session that this SessionStart begins, with no usage in its transcript
 * yet, to the config's backend and key. A resumed or compacted session, or one
 * already holding usage, is left for --assign. The first owner is kept for good.
 */
export function claimNewSession(config, input) {
  if (!config?.usageSyncEnabled || !isNewSession(input)) return false;
  const key = keyIdOf(config);
  const claim = { backend: backendOrigin(config), key, ...cachedOrg(config.dataDir, key) };
  try {
    return createClaim(ownerPath(config.dataDir, input.session_id), claim);
  } catch (err) {
    process.stderr.write(`[armorclaude] usage owner claim failed: ${err?.message ?? err}\n`);
    return false;
  }
}

async function validateKey(config) {
  try {
    return await postJson(
      `${config.backendEndpoint}/iap/validate-key`,
      {},
      buildAuthHeaders(config),
      config.timeoutMs
    );
  } catch (err) {
    const why = err?.cause?.code ?? err?.name ?? String(err);
    throw new Error(`backend unreachable at ${backendOrigin(config)}: ${why}`);
  }
}

export async function resolveScope(config) {
  const keyId = keyIdOf(config);
  const backend = backendOrigin(config);
  const cachePath = `${keyBase(config.dataDir, keyId)}.json`;
  let orgId = (await readJson(cachePath, null))?.orgId;
  if (typeof orgId !== "string" || !orgId) {
    const res = await validateKey(config);
    if (!res.ok || typeof res.data?.orgId !== "string" || !res.data.orgId) {
      throw new Error(`could not resolve the API key's organization: HTTP ${res.status}`);
    }
    orgId = res.data.orgId;
    await writeJson(cachePath, { backend, orgId });
  }
  return { backend, orgId, keyId, scopeId: scopeIdOf(backend, orgId) };
}

const listDir = (dir) =>
  readdir(dir).catch((err) => (err?.code === "ENOENT" ? [] : Promise.reject(err)));

async function readClaims(dataDir) {
  const dir = path.join(usageSyncDir(dataDir), "owners");
  const claims = new Map();
  for (const name of await listDir(dir)) {
    const claim = await readJson(path.join(dir, name), null);
    if (typeof claim?.backend !== "string" || typeof claim.file !== "string") continue;
    if (ownerPath(dataDir, claim.file) === path.join(dir, name)) claims.set(claim.file, claim);
  }
  return claims;
}

async function knownOrgs(dataDir) {
  const dir = path.join(usageSyncDir(dataDir), "keys");
  const names = await listDir(dir);
  const orgs = new Map();
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const entry = await readJson(path.join(dir, name), null);
    if (typeof entry?.orgId === "string") orgs.set(name.slice(0, -5), entry.orgId);
  }
  return orgs;
}

/** Main transcripts (resolved paths) whose claims belong to the scope's organization. */
export async function ownedTranscripts(config, scope, { pin = true } = {}) {
  const orgs = await knownOrgs(config.dataDir);
  const owned = new Set();
  for (const [transcript, claim] of await readClaims(config.dataDir)) {
    if (claim.backend !== scope.backend) continue;
    const orgId = claim.org ?? orgs.get(claim.key);
    if (orgId !== scope.orgId) continue;
    if (pin && !claim.org)
      await writeJson(ownerPath(config.dataDir, transcript), { ...claim, org: orgId });
    owned.add(transcript);
  }
  return owned;
}

export async function assignTranscripts(config, scope, transcripts) {
  const orgs = await knownOrgs(config.dataDir);
  const claims = await readClaims(config.dataDir);
  const result = { assigned: [], refused: [] };
  for (const transcript of transcripts.map((t) => path.resolve(t))) {
    const done = await assignOne(config, scope, transcript, claims.get(transcript), orgs);
    result[done ? "assigned" : "refused"].push(transcript);
  }
  return result;
}

async function assignOne(config, scope, transcript, claim, orgs) {
  const file = ownerPath(config.dataDir, transcript);
  if (!claim) {
    const owner = { file: transcript, backend: scope.backend, key: scope.keyId, org: scope.orgId };
    return createClaim(file, owner);
  }
  const orgId = claim.org ?? orgs.get(claim.key);
  if (claim.backend !== scope.backend || orgId !== scope.orgId) return false;
  if (!claim.org) await writeJson(file, { ...claim, org: orgId });
  return true;
}
