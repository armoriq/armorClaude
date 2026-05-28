import path from "node:path";
import { mkdir, readdir, unlink } from "node:fs/promises";
import { readJson, writeJson } from "./fs-store.mjs";
import { POLICY_TEMPLATES } from "./policy-templates.mjs";
import { legacyRulesToPolicyIr, normalizePolicyIr, policyIrToLegacyRules } from "./policy-ir.mjs";

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
    const policy = legacyRulesToPolicyIr(tmpl.rules, { name: key, description: tmpl.description }, { decision: "deny" });
    const rules = policyIrToLegacyRules(policy);
    await writeJson(filePath, {
      profile: {
        name: key,
        description: tmpl.description,
        createdAt: new Date().toISOString(),
        createdBy: "builtin",
        orgId: "local"
      },
      version: 1,
      policy: { ...policy, rules },
      rules
    });
  }
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
    if (data?.profile?.name) {
      profiles.push(data);
    }
  }
  return profiles;
}

export async function loadProfile(config, name) {
  await seedBuiltinProfiles(config);
  return readJson(profilePath(config, name), null);
}

export async function saveProfile(config, name, description, rulesOrPolicy) {
  await ensureProfilesDir(config);
  const existing = await readJson(profilePath(config, name), null);
  const version = existing ? (existing.version || 0) + 1 : 1;
  const policy = rulesOrPolicy?.schemaVersion
    ? normalizePolicyIr(rulesOrPolicy)
    : legacyRulesToPolicyIr(Array.isArray(rulesOrPolicy) ? rulesOrPolicy : [], { name, description }, { decision: "deny" });
  const rules = policyIrToLegacyRules(policy);
  const data = {
    profile: {
      name,
      description,
      createdAt: existing?.profile?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: "user",
      orgId: "local"
    },
    version,
    policy: { ...policy, rules },
    rules
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
