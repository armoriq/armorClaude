import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { autoUpdateNotice } from "../scripts/lib/update-notice.mjs";

async function machine({ userSettings, known, projectLocal, managed } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "update-notice-"));
  const configDir = path.join(root, "claude");
  const project = path.join(root, "project");
  await mkdir(path.join(configDir, "plugins"), { recursive: true });
  await mkdir(path.join(project, ".claude"), { recursive: true });
  const write = (file, value) => writeFile(file, JSON.stringify(value));
  if (userSettings) await write(path.join(configDir, "settings.json"), userSettings);
  if (known) await write(path.join(configDir, "plugins", "known_marketplaces.json"), known);
  if (managed) await write(path.join(root, "managed-settings.json"), managed);
  if (projectLocal) await write(path.join(project, ".claude", "settings.local.json"), projectLocal);
  const notice = (version = "0.2.19", env = {}) =>
    autoUpdateNotice({
      pluginRoot: path.join(configDir, "plugins", "cache", "armoriq", "armorclaude-dev", version),
      env: { CLAUDE_CONFIG_DIR: configDir, ...env },
      cwd: project,
      dataDir: path.join(root, "armoriq"),
      managed: path.join(root, "managed-settings.json"),
    });
  return { notice, configDir };
}

const entry = (autoUpdate) => ({
  extraKnownMarketplaces: {
    armoriq: { source: { source: "github", repo: "armoriq/armorClaude" }, autoUpdate },
  },
});

test("a marketplace nobody turned auto-update on for gets the notice once per installed version", async () => {
  const { notice } = await machine({ userSettings: entry(undefined) });
  const first = await notice("0.2.19");
  assert.match(first, /Enable auto-update/);
  assert.match(first, /"armoriq"/);
  assert.equal(await notice("0.2.19"), null);
  assert.match(await notice("0.2.20"), /Enable auto-update/);
});

for (const [name, setup, env] of [
  ["user settings turn it on", { userSettings: entry(true) }],
  ["managed settings turn it on", { managed: entry(true) }],
  ["the /plugin toggle turned it on", { known: { armoriq: { autoUpdate: true } } }],
  ["the user turned it off on purpose", { known: { armoriq: { autoUpdate: false } } }],
  ["project local settings decide over user settings", { projectLocal: entry(false) }],
  ["Claude Code's updater is disabled", {}, { DISABLE_AUTOUPDATER: "1" }],
  ["the installer was told to keep updates manual", {}, { ARMORCLAUDE_NO_AUTO_UPDATE: "1" }],
]) {
  test(`no notice when ${name}`, async () => {
    const { notice } = await machine(setup);
    assert.equal(await notice("0.2.19", env), null);
  });
}

test("FORCE_AUTOUPDATE_PLUGINS keeps plugin updates on when the updater is disabled", async () => {
  const { notice } = await machine();
  assert.match(
    await notice("0.2.19", { DISABLE_AUTOUPDATER: "1", FORCE_AUTOUPDATE_PLUGINS: "1" }),
    /Enable auto-update/
  );
});

test("a plugin loaded from a checkout rather than the marketplace cache gets no notice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "update-notice-"));
  assert.equal(await autoUpdateNotice({ pluginRoot: root, env: {}, dataDir: root }), null);
});
