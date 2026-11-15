import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { STAGING, PRODUCTION, tempHome, writeLoginProfiles } from "./helpers/login-profile.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repoRoot, "install_armorclaude.sh");
const contract = JSON.parse(
  readFileSync(new URL("./fixtures/install-ping-v1.json", import.meta.url))
);
const PTY = `
import os, select, sys
pid, fd = os.forkpty()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
answer = sys.stdin.buffer.read()
output = b""
sent = False
interrupted = False
status = None
while True:
    chunk = b""
    if select.select([fd], [], [], 0.05)[0]:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            pass
        output += chunk
        sys.stdout.buffer.write(chunk)
        sys.stdout.flush()
    if not sent and b"Connect your ArmorIQ account now?" in output:
        action = os.environ.get("PTY_ACTION", "answer")
        os.write(fd, b"\\x03" if action == "prompt-int" else b"\\x04" if action == "eof" else answer)
        sent = True
    if not interrupted and os.environ.get("PTY_ACTION") == "login-int" and b"LOGIN_READY" in output:
        os.write(fd, b"\\x03")
        interrupted = True
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
  "plugin install armorclaude@armoriq")
    [ "\${INSTALL_FAILURE:-}" != "1" ] || exit 42
    dir="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/armoriq/armorclaude/0.0.0"
    mkdir -p "$dir/scripts" && : > "$dir/scripts/bootstrap.mjs" ;;
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
  for (const name of ["npm", "npx", "armoriq", "armoriq-dev"]) stubs[name] = recorder(name, calls);
  const saveLogin = `import { writeLoginProfiles } from ${JSON.stringify(new URL("./helpers/login-profile.mjs", import.meta.url).href)}; writeLoginProfiles(process.env.HOME, [{ backend: process.argv.at(-1), apiKey: 'ak_test_installer' }]);`;
  for (const name of ["armoriq", "npx"])
    stubs[name] = `${recorder(name, calls).replace("exit 0\n", "")}
case "\${LOGIN_RESULT:-}" in
  fail) exit 42 ;;
  timeout) exit 124 ;;
  interrupt) printf 'LOGIN_READY\\n'; read -r answer; exit 130 ;;
esac
[ -t 0 ] && [ -t 1 ] && [ -t 2 ] || exit 43
node --input-type=module -e '${saveLogin.replaceAll("'", "'\\''")}' "$@"
`;
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  symlinkSync(process.execPath, path.join(bin, "node"));
  return {
    home,
    calls,
    env: { HOME: home, TMPDIR: process.env.TMPDIR, PATH: `${bin}:/usr/bin:/bin`, TERM: "dumb" },
  };
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

const guarded = (home) => [
  "-c",
  `[ "$HOME" = "${home}" ] && [ "$(command -v armoriq)" = "${home}/stub-bin/armoriq" ] || exit 99; exec bash "${installer}"`,
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
    assert.match(
      log,
      new RegExp(`^armoriq HOME=${home} login --product armorclaude --backend ${PRODUCTION}$`, "m"),
      out
    );
    assert.match(log, /^npm HOME=\S+ install -g @armoriq\/sdk@latest /m);
    assert.doesNotMatch(log, /^armoriq-dev HOME=/m);
    assert.match(out, /armoriq CLI ready/);
    assert.match(out, /ArmorIQ connected/);
  }
);

test("the installer points at armoriq when it cannot prompt", async () => {
  const { home, calls, env } = sandbox();
  const { code, out } = await run("/bin/bash", guarded(home), { env, detached: true });
  assert.equal(code, 0, out);
  assert.ok(
    out.includes(`Sign in later: armoriq login --product armorclaude --backend ${PRODUCTION}`)
  );
  assert.doesNotMatch(out, /\barmoriq-dev login\b/);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /^armoriq(-dev)? HOME=/m);
  assert.equal(out.split(/\r?\n/).filter((line) => line === contract.notice).length, 1);
  const marker = path.join(home, ".armoriq/reach/v1/armorclaude/notice-shown");
  assert.equal(lstatSync(marker).mode & 0o777, 0o600);
  for (let current = path.dirname(marker); current !== home; current = path.dirname(current))
    assert.equal(lstatSync(current).mode & 0o777, 0o700);
  const again = await run("/bin/bash", guarded(home), { env, detached: true });
  assert.equal(again.code, 0, again.out);
  assert.equal(again.out.includes(contract.notice), false);
});

for (const [name, input, extraEnv, loginCalled] of [
  ["decline", "n\n", {}, false],
  ["end of input", "", { PTY_ACTION: "eof" }, false],
  ["Ctrl-C at the prompt", "", { PTY_ACTION: "prompt-int" }, false],
  ["Ctrl-C during login", "y\n", { PTY_ACTION: "login-int", LOGIN_RESULT: "interrupt" }, true],
  ["failed login", "y\n", { LOGIN_RESULT: "fail" }, true],
  ["login timeout", "y\n", { LOGIN_RESULT: "timeout" }, true],
]) {
  test(
    `the installer finishes after ${name} and prints the exact command`,
    { skip: !ptyAvailable },
    async () => {
      const { home, calls, env } = sandbox();
      const { code, out } = await run(
        "/usr/bin/python3",
        ["-c", PTY, "/bin/bash", ...guarded(home)],
        { env: { ...env, ...extraEnv }, input }
      );
      assert.equal(code, 0, out);
      assert.ok(
        out.includes(`Sign in later: armoriq login --product armorclaude --backend ${PRODUCTION}`),
        out
      );
      assert.match(out, /ArmorClaude is installed\./);
      assert.equal(
        readFileSync(calls, "utf8").includes(" login --product armorclaude"),
        loginCalled
      );
    }
  );
}

for (const [extraEnv, backend] of [
  [{}, PRODUCTION],
  [{ ARMORIQ_ENV: " PrOd " }, PRODUCTION],
  [{ ARMORIQ_ENV: "stage" }, STAGING],
  [{ ARMORIQ_BACKEND_URL: "https://ignored.example.test" }, PRODUCTION],
]) {
  test(
    `the installer signs in to the plugin backend for ${JSON.stringify(extraEnv)}`,
    { skip: !ptyAvailable },
    async () => {
      const { home, calls, env } = sandbox();
      const { code, out } = await run(
        "/usr/bin/python3",
        ["-c", PTY, "/bin/bash", ...guarded(home)],
        { env: { ...env, ...extraEnv }, input: "y\n" }
      );
      assert.equal(code, 0, out);
      assert.ok(
        readFileSync(calls, "utf8").includes(`login --product armorclaude --backend ${backend}`)
      );
    }
  );
}

for (const [name, entries, skip] of [
  ["matching credentials", [{ backend: PRODUCTION, apiKey: "ak_test_existing" }], true],
  [
    "another product",
    [{ backend: PRODUCTION, product: "armorcodex", apiKey: "ak_test_other" }],
    false,
  ],
  ["another backend", [{ backend: STAGING, apiKey: "ak_live_other" }], false],
]) {
  test(`the installer handles ${name}`, { skip: !ptyAvailable }, async () => {
    const { home, calls, env } = sandbox();
    writeLoginProfiles(home, entries);
    const { code, out } = await run(
      "/usr/bin/python3",
      ["-c", PTY, "/bin/bash", ...guarded(home)],
      { env, input: "n\n" }
    );
    assert.equal(code, 0, out);
    assert.equal(out.includes("Connect your ArmorIQ account now?"), !skip);
    assert.equal(out.includes("Sign in later:"), !skip);
    assert.doesNotMatch(readFileSync(calls, "utf8"), /^armoriq HOME=/m);
  });
}

for (const extraEnv of [
  { ARMORIQ_ENV: "development" },
  { ARMORIQ_ENV: "dev" },
  { ARMORIQ_ENV: "local" },
  { ARMORIQ_ENV: "test", ARMORIQ_BACKEND_URL: "http://localhost:9000" },
  { ARMORIQ_LOCAL_MOCK: " On " },
  { LOCAL_MODE_FILE: "1" },
]) {
  test(`local mode skips installer sign in for ${JSON.stringify(extraEnv)}`, async () => {
    const { home, calls, env } = sandbox();
    if (extraEnv.LOCAL_MODE_FILE) {
      mkdirSync(path.join(home, ".armoriq"));
      writeFileSync(path.join(home, ".armoriq/local-mode"), "");
    }
    const { code, out } = await run("/bin/bash", guarded(home), {
      env: { ...env, ...extraEnv },
      detached: true,
    });
    assert.equal(code, 0, out);
    assert.doesNotMatch(out, /Connect your ArmorIQ account now\?|Sign in later:/);
    assert.doesNotMatch(readFileSync(calls, "utf8"), /^armoriq HOME=/m);
    assert.equal(out.includes(contract.notice), false);
    assert.equal(existsSync(path.join(home, ".armoriq/reach")), false);
  });
}

test("the installer uses the npx fallback when the SDK bin is unavailable", async () => {
  const { home, env } = sandbox();
  chmodSync(path.join(home, "stub-bin/armoriq"), 0o644);
  const { code, out } = await run("/bin/bash", [installer], { env, detached: true });
  assert.equal(code, 0, out);
  assert.ok(
    out.includes(
      `Sign in later: npx -y @armoriq/sdk login --product armorclaude --backend ${PRODUCTION}`
    )
  );
});

test("a failure outside sign in still fails the installer", async () => {
  const { home, env } = sandbox();
  const { code, out } = await run("/bin/bash", guarded(home), {
    env: { ...env, INSTALL_FAILURE: "1" },
    detached: true,
  });
  assert.equal(code, 42, out);
  assert.doesNotMatch(out, /ArmorClaude is installed\./);
});

for (const vector of contract.optOut.testVectors.filter((vector) => !vector.plugin)) {
  test(`the installer notice follows the global opt outs ${JSON.stringify(vector)}`, async (t) => {
    const { home, env } = sandbox();
    if (
      Object.hasOwn(vector, "settingsJson") ||
      vector.settings !== null ||
      vector.settingsReadable === false
    ) {
      const file = path.join(home, ".armoriq/settings.json");
      mkdirSync(path.dirname(file));
      const settings = Object.hasOwn(vector, "settingsJson")
        ? vector.settingsJson
        : (vector.settings ?? {});
      writeFileSync(file, settings === "malformed" ? "{" : JSON.stringify(settings));
      if (vector.settingsReadable === false) {
        chmodSync(file, 0);
        t.after(() => chmodSync(file, 0o600));
      }
    }
    const { code, out } = await run("/bin/bash", guarded(home), {
      env: { ...env, ...vector.env },
      detached: true,
    });
    assert.equal(code, 0, out);
    assert.equal(out.includes(contract.notice), vector.enabled);
    assert.equal(
      existsSync(path.join(home, ".armoriq/reach/v1/armorclaude/notice-shown")),
      vector.enabled
    );
    assert.equal(existsSync(path.join(home, ".armoriq/reach")), vector.enabled);
  });
}

for (const backend of [
  ...Object.values(contract.origins).flat(),
  "https://unlisted.example.test",
  `${PRODUCTION}/path`,
  `https://user@${new URL(PRODUCTION).host}`,
]) {
  test(`the installer notice follows the backend origin ${backend}`, async () => {
    const { home, env } = sandbox();
    const { code, out } = await run("/bin/bash", ["-s"], {
      env: { ...env, NOTICE_BACKEND: backend },
      input: `${readFileSync(installer, "utf8").replace(/\nmain "\$@"\s*$/, "")}
plugin_backend() { printf '%s' "$NOTICE_BACKEND"; }
finale
`,
      detached: true,
    });
    const enabled = Object.values(contract.origins).flat().includes(backend);
    assert.equal(code, 0, out);
    assert.equal(out.includes(contract.notice), enabled);
    assert.equal(
      existsSync(path.join(home, ".armoriq/reach/v1/armorclaude/notice-shown")),
      enabled
    );
    assert.equal(existsSync(path.join(home, ".armoriq/reach")), enabled);
  });
}

for (const configDir of [undefined]) {
  const where = configDir ? "under CLAUDE_CONFIG_DIR" : "under ~/.claude";
  test(`the installer warms the plugin Claude Code installed ${where}`, async () => {
    const { home, env } = sandbox();
    if (configDir) env.CLAUDE_CONFIG_DIR = path.join(home, configDir);
    const { code, out } = await run("/bin/bash", guarded(home), { env, detached: true });
    assert.equal(code, 0, out);
    assert.match(out, /dependencies ready/);
  });
}
