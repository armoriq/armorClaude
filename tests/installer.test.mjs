import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { tempHome } from "./helpers/login-profile.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(repoRoot, "install_armorclaude.sh");
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
  "plugin install armorclaude-dev@armoriq")
    mkdir -p "$HOME/.claude/plugins/cache/armoriq/armorclaude-dev/0.0.0" ;;
  "plugin list") printf 'armorclaude-dev@armoriq\\n  Status: enabled\\n' ;;
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

const guarded = (home) => [
  "-c",
  `[ "$HOME" = "${home}" ] && [ "$(command -v armoriq-dev)" = "${home}/stub-bin/armoriq-dev" ] || exit 99; exec bash "${installer}"`,
];

const ptyAvailable = existsSync("/usr/bin/python3");

test(
  "the installer signs in with armoriq-dev when the user agrees",
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
    assert.match(log, new RegExp(`^armoriq-dev HOME=${home} login --product armorclaude$`, "m"));
    assert.match(log, /^npm HOME=\S+ install -g @armoriq\/sdk-dev@latest /m);
    assert.doesNotMatch(log, /^armoriq HOME=/m);
    assert.match(out, /armoriq-dev CLI ready/);
  }
);

test("the installer points at armoriq-dev when it cannot prompt", async () => {
  const { home, calls, env } = sandbox();
  const { code, out } = await run("/bin/bash", guarded(home), { env, detached: true });
  assert.equal(code, 0, out);
  assert.match(out, /Run armoriq-dev login --product armorclaude to connect later\./);
  assert.doesNotMatch(out, /\barmoriq login\b/);
  assert.doesNotMatch(readFileSync(calls, "utf8"), /^armoriq(-dev)? HOME=/m);
});
