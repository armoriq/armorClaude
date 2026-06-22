import path from "node:path";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { readJson, writeJson } from "./fs-store.mjs";
import { POLICY_TEMPLATES } from "./policy-templates.mjs";
import { legacyRulesToPolicyIr, normalizePolicyIr } from "./policy-ir.mjs";

function profilesDir(config) {
  return path.join(config.dataDir, "profiles");
}

function profilePath(config, name) {
  return path.join(profilesDir(config), `${name}.json`);
}

export async function ensureProfilesDir(config) {
  await mkdir(profilesDir(config), { recursive: true });
}

export async function seedBuiltinProfiles(config) {
  await ensureProfilesDir(config);
  for (const [key, tmpl] of Object.entries(POLICY_TEMPLATES)) {
    const filePath = profilePath(config, key);
    const existing = await readJson(filePath, null);
    if (existing) continue;
    const policy = normalizePolicyIr(tmpl.policy);
    await writeJson(filePath, {
      profile: {
        name: key,
        description: tmpl.description,
        createdAt: new Date().toISOString(),
        createdBy: "builtin",
        orgId: "local",
      },
      version: 1,
      policy,
    });
  }
}

function normalizeProfileData(data, fallbackName = "profile") {
  if (!data?.profile?.name) return null;
  const description = data.profile.description || "";
  const policy = data.policy?.schemaVersion
    ? normalizePolicyIr(data.policy)
    : legacyRulesToPolicyIr(
        Array.isArray(data.policy?.rules)
          ? data.policy.rules
          : Array.isArray(data.rules)
            ? data.rules
            : [],
        { name: data.profile.name || fallbackName, description },
        { decision: "deny" }
      );
  return {
    profile: data.profile,
    version: data.version || 1,
    policy,
  };
}

export async function listProfiles(config) {
  await seedBuiltinProfiles(config);
  const dir = profilesDir(config);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const profiles = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const data = await readJson(path.join(dir, f), null);
    const normalized = normalizeProfileData(data, f.replace(/\.json$/, ""));
    if (normalized) {
      profiles.push(normalized);
    }
  }
  return profiles;
}

export async function loadProfile(config, name) {
  await seedBuiltinProfiles(config);
  const data = await readJson(profilePath(config, name), null);
  const normalized = normalizeProfileData(data, name);
  if (normalized && JSON.stringify(normalized) !== JSON.stringify(data)) {
    await writeJson(profilePath(config, name), normalized);
  }
  return normalized;
}

export async function saveProfile(config, name, description, policyLike) {
  await ensureProfilesDir(config);
  const existing = await readJson(profilePath(config, name), null);
  const version = existing ? (existing.version || 0) + 1 : 1;
  const policy = policyLike?.schemaVersion
    ? normalizePolicyIr(policyLike)
    : legacyRulesToPolicyIr(
        Array.isArray(policyLike) ? policyLike : policyLike?.rules || [],
        { name, description },
        { decision: "deny" }
      );
  const data = {
    profile: {
      name,
      description,
      createdAt: existing?.profile?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: "user",
      orgId: "local",
    },
    version,
    policy,
  };
  await writeJson(profilePath(config, name), data);
  return data;
}

export async function deleteProfile(config, name) {
  const filePath = profilePath(config, name);
  const existing = await readJson(filePath, null);
  if (!existing) return false;
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}
