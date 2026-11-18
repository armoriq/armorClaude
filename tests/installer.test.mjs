import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { tempHome } from "./helpers/login-profile.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repoRoot, "install_armorclaude.sh");
const devInstaller = path.join(repoRoot, "install_armorclaude_dev.sh");
const PTY = `
import os, select, sys
pid, fd = os.forkpty()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
os.write(fd, sys.stdin.buffer.read())
status = None
while True:
    chunk = b""
    if select.select([fd], [], [], 0.05)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            pass
        sys.stdout.buffer.write(chunk)
    if status is None:
        done, st = os.waitpid(pid, os.WNOHANG)
        status = st if done else None
    if status is not None and not chunk:
        break
sys.stdout.flush()
sys.exit(os.waitstatus_to_exitcode(status))
`;

const CLAUDE_STUB = `#!/bin/sh
case "$*" in
  --version) echo "2.0.0 (Claude Code)" ;;
  "plugin install armorclaude@armoriq"|"plugin install armorclaude-dev@armoriq")
    dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/armoriq/\${3%@armoriq}/0.0.0"
    mkdir -p "$dir/scripts" && : > "$dir/scripts/bootstrap.mjs" ;;
  "plugin marketplace add "*)
    dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    node -e 'const fs = require("fs");
      for (const [file, entry] of [[process.argv[1], (j) => j.extraKnownMarketplaces?.armoriq], [process.argv[2], (j) => j.armoriq]]) {
        try {
          const json = JSON.parse(fs.readFileSync(file, "utf8"));
          if (entry(json)) delete entry(json).autoUpdate;
          fs.writeFileSync(file, JSON.stringify(json));
        } catch {}
      }' "$dir/settings.json" "$dir/plugins/known_marketplaces.json" ;;
  "plugin list") printf 'armorclaude@armoriq\\n  Status: enabled\\n' ;;
  "mcp list") echo "plugin:armorclaude:armorclaude-policy: node - Connected" ;;
esac
exit 0
`;

const recorder = (name, log) => `#!/bin/sh
printf '%s HOME=%s %s\\n' "${name}" "$HOME" "$*" >> "${log}"
exit 0
`;

function sandbox() {
  const home = tempHome();
  const bin = path.join(home, "stub-bin");
  const calls = path.join(home, "calls.log");
  mkdirSync(bin);
  writeFileSync(calls, "");
  const stubs = { claude: CLAUDE_STUB, git: "#!/bin/sh\nexit 0\n" };
  for (const name of ["npm", "npx", "armoriq", "armoriq"]) stubs[name] = recorder(name, calls);
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  symlinkSync(process.execPath, path.join(bin, "node"));
  return { home, calls, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, TERM: "dumb" } };
}

function run(cmd, args, { env, input, detached }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, detached, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, out: stripVTControlCharacters(out) }));
    child.stdin.end(input ?? "");
  });
}

const guarded = (home, script = installer) => [
  "-c",
  `[ "$HOME" = "${home}" ] && [ "$(command -v armoriq)" = "${home}/stub-bin/armoriq" ] || exit 99; exec bash "${script}"`,
];

const ptyAvailable = existsSync("/usr/bin/python3");

test(
  "the installer signs in with armoriq when the user agrees",
  { skip: !ptyAvailable },
  async () => {
    const { home, calls, env } = sandbox();
    const { code, out } = await run(
      "/usr/bin/python3",
      ["-c", PTY, "/bin/bash", ...guarded(home)],
      {
        env,
        input: "y\n",
      }
    );
    assert.equal(code, 0, out);
    const log = readFileSync(calls, "utf8");
    assert.match(log, new RegExp(`^armoriq HOME=${home} login --product armorclaude$`, "m"));
    assert.match(log, /^npm HOME=\S+ install -g @armoriq\/sdk@latest /m);
    assert.doesNotMatch(log, /^armoriq-dev HOME=/m);
    assert.match(out, /armoriq CLI ready/);
  }
);

test("the installer points at armoriq when it cannot prompt", async () => {
  const { home, calls, env } = sandbox();
  const { code, out } = await run("/bin/bash", guarded(home), { env, detached: true });
  assert.equal(code, 0, out);
  assert.match(out, /Run armoriq login --product armorclaude to connect later\./);
  assert.doesNotMatch(out, /\barmoriq-dev login\b/);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /^armoriq(-dev)? HOME=/m);
});

for (const configDir of [undefined, ".claude-second"]) {
  const where = configDir ? "under CLAUDE_CONFIG_DIR" : "under ~/.claude";
  test(`the installer warms the plugin Claude Code installed ${where}`, async () => {
    const { home, env } = sandbox();
    if (configDir) env.CLAUDE_CONFIG_DIR = path.join(home, configDir);
    const { code, out } = await run("/bin/bash", guarded(home), { env, detached: true });
    assert.equal(code, 0, out);
    assert.match(out, /dependencies ready/);
    const settings = path.join(
      env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
      "settings.json"
    );
    assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")).extraKnownMarketplaces.armoriq, {
      source: { source: "github", repo: "armoriq/armorClaude" },
      autoUpdate: true,
    });
  });
}

test("the installer turns on auto-update without disturbing the user's settings", async () => {
  const { home, env } = sandbox();
  const settings = path.join(home, ".claude", "settings.json");
  const target = path.join(home, "dotfiles", "claude-settings.json");
  mkdirSync(path.dirname(settings), { recursive: true });
  mkdirSync(path.dirname(target), { recursive: true });
  const source = { source: "git", url: "https://example.test/fork.git" };
  writeFileSync(
    target,
    JSON.stringify({ theme: "dark", extraKnownMarketplaces: { armoriq: { source } } }),
    { mode: 0o600 }
  );
  symlinkSync(target, settings);
  const { code, out } = await run("/bin/bash", guarded(home), { env, detached: true });
  assert.equal(code, 0, out);
  assert.match(out, /updates are automatic/);
  assert.equal(lstatSync(settings).isSymbolicLink(), true);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
    theme: "dark",
    extraKnownMarketplaces: { armoriq: { source, autoUpdate: true } },
  });
});

const armoriqEntry = (autoUpdate) => ({
  source: { source: "github", repo: "armoriq/armorClaude" },
  ...(autoUpdate !== undefined && { autoUpdate }),
});

for (const [name, settings, toggle, expected, message] of [
  ["turned it off in settings", armoriqEntry(false), undefined, false, /leaving updates manual/],
  ["turned it off with /plugin", armoriqEntry(), false, false, /leaving updates manual/],
  ["already had it on", armoriqEntry(true), undefined, true, /updates are (already )?automatic/],
]) {
  test(`marketplace add drops autoUpdate, and the installer keeps it for a user who ${name}`, async () => {
    const { home, env } = sandbox();
    const file = path.join(home, ".claude", "settings.json");
    mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(file, JSON.stringify({ extraKnownMarketplaces: { armoriq: settings } }));
    if (toggle !== undefined) {
      writeFileSync(
        path.join(home, ".claude", "plugins", "known_marketplaces.json"),
        JSON.stringify({ armoriq: { autoUpdate: toggle } })
      );
    }
    const { code, out } = await run("/bin/bash", guarded(home), { env, detached: true });
    assert.equal(code, 0, out);
    assert.match(out, message);
    const after = JSON.parse(readFileSync(file, "utf8")).extraKnownMarketplaces.armoriq;
    assert.equal(after.autoUpdate, expected);
  });
}

test("the installer leaves updates manual when asked to", async () => {
  const { home, env } = sandbox();
  env.ARMORCLAUDE_NO_AUTO_UPDATE = "1";
  const { code, out } = await run("/bin/bash", guarded(home), { env, detached: true });
  assert.equal(code, 0, out);
  assert.equal(existsSync(path.join(home, ".claude", "settings.json")), false);
});

test("the dev installer installs armorclaude-dev, points at armoriq-dev and turns on auto-update", async () => {
  const { home, calls, env } = sandbox();
  const { code, out } = await run("/bin/bash", guarded(home, devInstaller), {
    env,
    detached: true,
  });
  assert.equal(code, 0, out);
  assert.match(out, /dependencies ready/);
  assert.match(out, /Run armoriq-dev login --product armorclaude to connect later\./);
  assert.match(readFileSync(calls, "utf8"), /^npm HOME=\S+ install -g @armoriq\/sdk-dev@latest /m);
  const settings = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.extraKnownMarketplaces.armoriq.autoUpdate, true);
});
