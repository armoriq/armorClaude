import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { loadConfig } from "../scripts/lib/config.mjs";
import { handlePreToolUse, handleSessionStart } from "../scripts/lib/engine.mjs";
import { tempHome } from "./helpers/login-profile.mjs";

const home = tempHome();
const workDir = tempHome();
const savedHome = process.env.HOME;
let config;

before(() => {
  process.env.HOME = home;
  assert.equal(os.homedir(), home);
  config = loadConfig({ CLAUDE_PLUGIN_DATA: tempHome(), ARMORIQ_ENV: "staging" });
  assert.equal(config.mode, "monitor");
});
after(() => {
  process.env.HOME = savedHome;
});

async function toolDecision(tool_name, tool_input) {
  const out = await handlePreToolUse(
    { hook_event_name: "PreToolUse", session_id: "guard", tool_name, tool_input, cwd: workDir },
    config
  );
  return out?.hookSpecificOutput?.permissionDecision ?? "allow";
}

const decision = (command) => toolDecision("Bash", { command });

const data = () => config.dataDir;

const ALLOWED = [
  () => "stat ~/.armoriq/credentials.json; ls missing 2>/dev/null",
  () => "cat ~/.armoriq/credentials.json",
  () => "cp ~/.armoriq/credentials.json /tmp/creds-copy",
  () => "rm -f _pages/about_einstein.md _pages/profiles.md",
  () => `echo done > notes.txt && cat ${data()}/policy.json`,
  () => "cp /etc/hosts /srv/other-app/credentials.json",
  () => "ls ~/.armoriq 2>&1 | head",
  () => 'echo "a > b" && cat ~/.armoriq/credentials.json',
  () => "cp ~/.armoriq/credentials.json ./backup/",
  () => "cp notes.txt ~/",
  () => "mv notes.txt ~",
  () => "rm -rf ~/projects/old node_modules",
  () => "chmod 755 ~",
  () => "cp ~/.armoriq/cred* /tmp/",
  () => "rm -f ./build/*.o",
  () => 'for f in *.log; do rm "$f"; done',
];

const DENIED = [
  () => "echo x > ~/.armoriq/credentials.json",
  () => 'echo {} >> "$HOME/.armoriq/credentials.json"',
  () => "rm $HOME/.armoriq/credentials.json",
  () => "mv ~/.armoriq/credentials.json /tmp/x",
  () => "cd ~/.armoriq && rm credentials.json",
  () => `cp /tmp/evil.json ${data()}/policy.json`,
  () => `tee ${data()}/policy.json < /dev/null`,
  () => `sed -i s/a/b/ ${data()}/policy.json`,
  () => `dd if=/dev/zero of=${data()}/policy.json`,
  () => `cp /tmp/evil.json ${data()}/profiles/strict.json`,
  () => "cat x > $SOME_DIR/credentials.json",
  () => "/bin/rm ~/.armoriq/credentials.json",
  () => "\\rm ~/.armoriq/credentials.json",
  () => "command rm ~/.armoriq/credentials.json",
  () => "env X=1 rm ~/.armoriq/credentials.json",
  () => "sudo -u root rm ~/.armoriq/credentials.json",
  () => "nice -n 5 rm ~/.armoriq/credentials.json",
  () => "echo ~/.armoriq/credentials.json | xargs rm",
  () => "{ rm ~/.armoriq/credentials.json; }",
  () => "true & rm ~/.armoriq/credentials.json",
  () => "cp /tmp/credentials.json ~/.armoriq/",
  () => "mv x/credentials.json ~/.armoriq",
  () => "cp -t ~/.armoriq /tmp/credentials.json",
  () => 'rm "$HOME"/.armoriq/credentials.json',
  () => 'rm "a;b" ~/.armoriq/credentials.json',
  () => "echo x >| ~/.armoriq/credentials.json",
  () => "echo x>~/.armoriq/credentials.json",
  () => "cd -P ~/.armoriq && rm credentials.json",
  () => "pushd ~/.armoriq && rm credentials.json",
  () => "rm -rf ~/.armoriq",
  () => "rm -rf /",
  () => "cd / && rm -rf *",
  () => "rm -rf ~/.armoriq/",
  () => "rm -rf $HOME/.armoriq",
  () => "cd ~ && rm -rf .armoriq",
  () => "mv ~/.armoriq /tmp/x",
  () => "chmod -R 777 ~/.armoriq",
  () => `rm -rf ${data()}`,
  () => `mv ${data()} /tmp/x`,
  () => "rm -rf ~/.arm*",
  () => "rm ~/.armoriq/*",
  () => "mv ~/.armoriq/cred* /tmp/",
  () => "cp /tmp/cred* ~/.armoriq/",
  () => "cp /tmp/evil.json ~/.armoriq/cred*",
  () => "f=credentials; rm ~/.armoriq/$f.json",
  () => "rm ~/.armoriq/$(echo credentials).json",
  () => `echo {} > ${data()}/runtime.json`,
  () => `cp /tmp/forged.json ${data()}/runtime.json`,
  () => `echo '{"mode":"shadow"}' > ${data()}/org-mode.json`,
];

for (const [tool, input] of [
  ["Write", () => ({ file_path: `${data()}/runtime.json`, content: "{}" })],
  ["Edit", () => ({ file_path: `${data()}/runtime.json`, old_string: "a", new_string: "b" })],
  ["Write", () => ({ file_path: `${data()}/org-mode.json`, content: '{"mode":"shadow"}' })],
  ["Write", () => ({ file_path: `${data()}/pending-plan.guard.json`, content: "{}" })],
]) {
  test(`the guard denies ${tool} to ArmorClaude state (#84): ${input().file_path}`, async () => {
    assert.equal(await toolDecision(tool, input()), "deny");
  });
}

test("the guard lets Write through outside ArmorClaude state", async () => {
  assert.equal(
    await toolDecision("Write", { file_path: `${workDir}/runtime.json`, content: "{}" }),
    "allow"
  );
});

const ADMIN_ALLOWED = [
  "grep -n savePolicyState scripts/lib/policy.mjs",
  "cat ~/.claude/plugins/data/x/policy-pending.json",
  "git log -S handleArmorPolicyCommand --oneline",
];

const ADMIN_DENIED = [
  `node -e "import('./scripts/lib/policy.mjs').then((m) => m.savePolicyState('p', {}))"`,
  "node scripts/lib/armor-policy-commands.mjs confirm",
  'bash -c "node armor-policy-cli.mjs"',
  'echo "savePolicyState" | node',
  "./scripts/lib/armor-policy-commands.mjs",
  "npx tsx armor-policy-cli.ts",
  'node <<EOF\nimport { savePolicyState } from "./x.mjs";\nEOF',
];

for (const command of ADMIN_ALLOWED) {
  test(`the guard lets a command that only reads policy code through (#121): ${command}`, async () => {
    assert.equal(await decision(command), "allow");
  });
}

for (const command of ADMIN_DENIED) {
  test(`the guard denies running the policy handler outside /armor (#121): ${command}`, async () => {
    assert.equal(await decision(command), "deny");
  });
}

for (const command of ALLOWED) {
  test(`the guard lets a command through when it writes no protected file: ${command()}`, async () => {
    assert.equal(await decision(command()), "allow");
  });
}

for (const command of DENIED) {
  test(`the guard denies a write to a protected file, even in monitor mode: ${command()}`, async () => {
    assert.equal(await decision(command()), "deny");
  });
}

test("the monitor banner says tool calls are not checked against a plan", async () => {
  const out = await handleSessionStart(
    { hook_event_name: "SessionStart", session_id: "banner" },
    config
  );
  const context = out.hookSpecificOutput.additionalContext;
  assert.match(context, /tool calls are not checked against a plan/);
  assert.doesNotMatch(context, /not blocked/);
});
