import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_INTERVAL_MS, STATE_FILE, selfUpdateOnHook } from "../scripts/lib/self-update.mjs";
import { cleanEnv, isNewer, runSelfUpdate } from "../scripts/self-update.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = path.join(repo, "scripts", "self-update.mjs");

const STUB = `#!/bin/sh
printf '%s CHILD=%s CLAUDECODE=%s\\n' "$*" "$ARMORCLAUDE_SELF_UPDATE_CHILD" "$CLAUDECODE" >> "$STUB_LOG"
case "$*" in
  "plugin update "*)
    [ "\${STUB_EXIT:-0}" = 0 ] || exit "$STUB_EXIT"
    dir="$CLAUDE_CONFIG_DIR/plugins/cache/new"
    mkdir -p "$dir/scripts"
    printf 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.STUB_LOG + ".warm", process.argv[2]);' > "$dir/scripts/bootstrap.mjs"
    printf '{"plugins":{"%s":[{"version":"%s","installPath":"%s"}]}}' "$3" "$STUB_NEW_VERSION" "$dir" > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json" ;;
esac
exit 0
`;

function machine({ plugin = "armorclaude", installed = "0.2.20", entry, settings } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "self-update-"));
  const configDir = path.join(root, "claude");
  const market = path.join(root, "market");
  const bin = path.join(root, "bin");
  const dataDir = path.join(root, "data");
  mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  mkdirSync(path.join(market, ".claude-plugin"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(path.join(bin, "claude"), STUB);
  chmodSync(path.join(bin, "claude"), 0o755);
  writeFileSync(
    path.join(configDir, "plugins", "known_marketplaces.json"),
    JSON.stringify({ armoriq: { installLocation: market } })
  );
  writeFileSync(
    path.join(market, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ plugins: [{ name: plugin, ...entry }] })
  );
  if (settings) writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(settings));
  const pluginRoot = path.join(configDir, "plugins", "cache", "armoriq", plugin, installed);
  mkdirSync(pluginRoot, { recursive: true });
  const log = path.join(root, "claude.log");
  writeFileSync(log, "");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    STUB_LOG: log,
    STUB_NEW_VERSION: entry?.version ?? "fresh",
  };
  return { root, configDir, dataDir, pluginRoot, env, calls: () => readFileSync(log, "utf8") };
}

for (const [latest, installed, newer] of [
  ["0.2.21", "0.2.20", true],
  ["0.3.0", "0.2.99", true],
  ["0.2.20", "0.2.20", false],
  ["0.2.19", "0.2.20", false],
  ["fresh", "0.2.20", false],
]) {
  test(`isNewer(${latest}, ${installed}) is ${newer}`, () => {
    assert.equal(isNewer(latest, installed), newer);
  });
}

test("the claude it runs is a plain CLI call, not part of the hook's session", () => {
  const env = cleanEnv({
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: "/c",
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_PLUGIN_ROOT: "/p",
    CLAUDE_PROJECT_DIR: "/w",
  });
  assert.deepEqual(env, {
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: "/c",
    ARMORCLAUDE_SELF_UPDATE_CHILD: "1",
  });
});

for (const [name, setup, result, updates] of [
  ["a newer stable version is installed", {}, "updated", true],
  ["the installed version is current", { entry: { version: "0.2.20" } }, "current", false],
  [
    "autoUpdate false only records the new version",
    { settings: { extraKnownMarketplaces: { armoriq: { autoUpdate: false } } } },
    "available",
    false,
  ],
  [
    "ARMORCLAUDE_NO_AUTO_UPDATE only records the new version",
    { optOutEnv: true },
    "available",
    false,
  ],
  ["a failing claude plugin update is reported, not hidden", { exit: "1" }, "failed", true],
]) {
  test(`self-update: ${name}`, async () => {
    const m = machine({ entry: { version: "0.2.21" }, ...setup });
    if (setup.optOutEnv) m.env.ARMORCLAUDE_NO_AUTO_UPDATE = "1";
    if (setup.exit) m.env.STUB_EXIT = setup.exit;
    const outcome = await runSelfUpdate({ pluginRoot: m.pluginRoot }, m.env);
    assert.equal(outcome.result, result);
    assert.match(m.calls(), /^plugin marketplace update armoriq CHILD=1 CLAUDECODE=$/m);
    assert.equal(/^plugin update armorclaude@armoriq /m.test(m.calls()), updates, m.calls());
    assert.equal(
      existsSync(`${m.env.STUB_LOG}.warm`),
      result === "updated",
      "only a new install is warmed"
    );
  });
}

test("self-update: the dev channel updates when dev has a new commit", async () => {
  const m = machine({ plugin: "armorclaude-dev", installed: "aaaaaaaaaaaa" });
  const git = path.join(m.root, "dev.git");
  execFileSync("git", ["init", "-q", "-b", "dev", git]);
  execFileSync("git", [
    "-C",
    git,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "dev",
  ]);
  const sha = execFileSync("git", ["-C", git, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(
    path.join(m.root, "market", ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      plugins: [{ name: "armorclaude-dev", source: { source: "url", url: git, ref: "dev" } }],
    })
  );
  m.env.STUB_NEW_VERSION = sha.slice(0, 12);
  const outcome = await runSelfUpdate({ pluginRoot: m.pluginRoot }, m.env);
  assert.deepEqual(outcome, {
    result: "updated",
    latest: sha.slice(0, 12),
    version: sha.slice(0, 12),
  });
  assert.match(m.calls(), /^plugin update armorclaude-dev@armoriq CHILD=1 /m);
});

test("the worker records an update and the next hook tells the person once", async () => {
  const m = machine({ entry: { version: "0.2.21" } });
  const run = spawnSync(
    process.execPath,
    [worker, JSON.stringify({ dataDir: m.dataDir, pluginRoot: m.pluginRoot })],
    {
      env: m.env,
      encoding: "utf8",
    }
  );
  assert.equal(run.status, 0, run.stderr);
  const hook = () =>
    selfUpdateOnHook({ dataDir: m.dataDir, pluginRoot: m.pluginRoot, env: {}, check: false });
  assert.equal(await hook(), "ArmorClaude updated to 0.2.21. Run /reload-plugins to use it.");
  assert.equal(await hook(), null);
});

test("a new session already running the update is not told to reload", async () => {
  const m = machine();
  mkdirSync(m.dataDir, { recursive: true });
  writeFileSync(
    path.join(m.dataDir, STATE_FILE),
    JSON.stringify({ updated: { version: "0.2.21", announced: false } })
  );
  const upgraded = path.join(m.configDir, "plugins", "cache", "armoriq", "armorclaude", "0.2.21");
  const hook = () =>
    selfUpdateOnHook({ dataDir: m.dataDir, pluginRoot: upgraded, env: {}, check: false });
  assert.equal(await hook(), "ArmorClaude updated to 0.2.21.");
  assert.equal(await hook(), null);
});

test("an opted-out user is told once per new version, and not once it is installed", async () => {
  const m = machine();
  const state = path.join(m.dataDir, STATE_FILE);
  mkdirSync(m.dataDir, { recursive: true });
  writeFileSync(state, JSON.stringify({ available: { version: "0.2.21" } }));
  const hook = (pluginRoot = m.pluginRoot) =>
    selfUpdateOnHook({ dataDir: m.dataDir, pluginRoot, env: {}, check: false });
  assert.equal(
    await hook(),
    "ArmorClaude 0.2.21 is available (you have 0.2.20). Update with: claude plugin update armorclaude@armoriq"
  );
  assert.equal(await hook(), null);
  writeFileSync(state, JSON.stringify({ available: { version: "0.2.22", noticed: "0.2.21" } }));
  assert.match(await hook(), /0\.2\.22 is available/);
  writeFileSync(state, JSON.stringify({ available: { version: "0.2.23" } }));
  const upgraded = path.join(m.configDir, "plugins", "cache", "armoriq", "armorclaude", "0.2.23");
  assert.equal(await hook(upgraded), null);
});

test("SessionStart starts at most one check a day, and never from the worker's own claude", async () => {
  const m = machine();
  const started = [];
  const hook = (now, env = {}, check = true) =>
    selfUpdateOnHook({
      dataDir: m.dataDir,
      pluginRoot: m.pluginRoot,
      env,
      check,
      now,
      startWorker: (job) => started.push(job),
    });
  await hook(1_000);
  await hook(2_000);
  await hook(3_000, {}, false);
  assert.equal(started.length, 1);
  assert.deepEqual(started[0], { dataDir: m.dataDir, pluginRoot: m.pluginRoot, cwd: undefined });
  await hook(1_000 + CHECK_INTERVAL_MS);
  assert.equal(started.length, 2);
  await hook(10 * CHECK_INTERVAL_MS, { ARMORCLAUDE_SELF_UPDATE_CHILD: "1" });
  assert.equal(started.length, 2);
});

test("a plugin loaded from a checkout rather than the marketplace cache never self-updates", async () => {
  const started = [];
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "self-update-"));
  const out = await selfUpdateOnHook({
    dataDir,
    pluginRoot: repo,
    env: {},
    check: true,
    startWorker: (job) => started.push(job),
  });
  assert.equal(out, null);
  assert.equal(started.length, 0);
});
