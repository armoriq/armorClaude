import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { applyReach } from "../scripts/lib/reach.mjs";
import { loadConfig, loginCommand, notSignedIn, statusCommand } from "../scripts/lib/config.mjs";
import { startBackend, startHookSession } from "./helpers/hook-session.mjs";
import { PRODUCTION, STAGING, tempHome, withHome } from "./helpers/login-profile.mjs";

const reachUrl = new URL("../scripts/lib/reach.mjs", import.meta.url).href;
const config = {
  backendEndpoint: PRODUCTION,
  armoriqEnv: "production",
  unconfigured: true,
  signInReminderEnabled: true,
  usagePingEnabled: false,
};
const reminder = (backend = PRODUCTION) =>
  `ArmorClaude is not signed in to ArmorIQ. Sign in to see your plans and blocks on your dashboard: ${loginCommand(backend)} (hide this reminder: ARMORIQ_SIGNIN_REMINDER_DISABLED=1)`;
const dirFor = (home, environment = "production") =>
  path.join(home, ".armoriq/reach/v1/armorclaude", environment);
const notice = JSON.parse(
  readFileSync(new URL("./fixtures/install-ping-v1.json", import.meta.url))
).notice;

test("the reminder claims one UTC day per call, survives clock rollback and cleans only its old dated files", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = dirFor(home);
  mkdirSync(dir, { recursive: true });
  const kept = [
    "reminder-2026-10-16",
    "reminder-2026-02-30",
    "reminder-2026-12-01",
    "ping-2026-10-14",
    "counts-2026-10-14.ndjson",
  ];
  for (const file of [...kept, "reminder-2026-10-14"]) writeFileSync(path.join(dir, file), "");
  const output = {
    systemMessage: "Existing notice",
    hookSpecificOutput: { additionalContext: "model context" },
  };
  let reads = 0;
  const deps = {
    home,
    now: () => {
      reads += 1;
      return Date.parse("2026-11-14T23:59:59.999Z");
    },
  };
  const first = applyReach("SessionStart", {}, config, output, deps);
  assert.equal(first.systemMessage, `Existing notice\n\n${reminder()}`);
  assert.equal(first.hookSpecificOutput, output.hookSpecificOutput);
  assert.equal(reads, 1);
  assert.equal(lstatSync(path.join(dir, "reminder-2026-11-14")).mode & 0o777, 0o600);
  assert.equal(applyReach("SessionStart", {}, config, output, deps), output);
  assert.equal(
    applyReach("SessionStart", {}, config, output, {
      home,
      now: () => Date.parse("2026-11-15T00:00:00Z"),
    }).systemMessage,
    `Existing notice\n\n${reminder()}`
  );
  assert.equal(applyReach("SessionStart", {}, config, output, deps), output);
  assert.deepEqual(
    readdirSync(dir).sort(),
    [...kept, "reminder-2026-11-14", "reminder-2026-11-15"].sort()
  );
  assert.equal(existsSync(path.join(home, ".armoriq/install-id")), false);
});

for (const blocked of ["notice", "reminder"]) {
  for (const code of ["EEXIST", "EACCES"]) {
    test(`${code} claiming the ${blocked} does not suppress the other message`, (t) => {
      const home = tempHome();
      const original = fs.openSync;
      t.mock.method(fs, "openSync", (file, ...args) => {
        if (
          blocked === "notice"
            ? String(file).endsWith("notice-shown")
            : path.basename(file).startsWith("reminder-")
        )
          throw Object.assign(new Error(code), { code });
        return original(file, ...args);
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        rmSync(home, { recursive: true, force: true });
      });
      const output = {
        systemMessage: "Existing notice",
        hookSpecificOutput: { additionalContext: "model context" },
      };
      const result = applyReach("SessionStart", {}, { ...config, usagePingEnabled: true }, output, {
        home,
      });
      assert.equal(
        result.systemMessage,
        `Existing notice\n\n${blocked === "notice" ? reminder() : notice}`
      );
      assert.equal(result.hookSpecificOutput, output.hookSpecificOutput);
    });
  }
}

test("the first session appends the ping notice then the reminder after an existing message", () => {
  const home = tempHome();
  const output = {
    systemMessage: "Existing notice",
    hookSpecificOutput: { additionalContext: "model context" },
  };
  const result = applyReach("SessionStart", {}, { ...config, usagePingEnabled: true }, output, {
    home,
  });
  assert.equal(result.systemMessage, `Existing notice\n\n${notice}\n\n${reminder()}`);
  assert.equal(result.hookSpecificOutput, output.hookSpecificOutput);
});

test("racing processes claim the reminder only once", async () => {
  const home = tempHome();
  const source = `import { applyReach } from ${JSON.stringify(reachUrl)}; process.stdout.write(JSON.stringify(applyReach('SessionStart', {}, ${JSON.stringify(config)}, {}, { home: process.env.HOME })));`;
  const runs = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
            env: { ...process.env, HOME: home },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) => {
            assert.equal(code, 0);
            resolve(JSON.parse(output));
          });
        })
    )
  );
  assert.equal(runs.filter((run) => run.systemMessage === reminder()).length, 1);
});

for (const overrides of [
  { unconfigured: false },
  { unconfigured: false, signedOut: true, signInReminderEnabled: false },
  { armoriqEnv: "local" },
  { backendEndpoint: "https://custom.example.test" },
]) {
  test(`the reminder does not claim for ${JSON.stringify(overrides)}`, () => {
    const home = tempHome();
    const output = { hookSpecificOutput: { additionalContext: "unchanged" } };
    assert.equal(
      applyReach("SessionStart", {}, { ...config, ...overrides }, output, { home }),
      output
    );
    assert.equal(existsSync(path.join(home, ".armoriq/reach")), false);
  });
}

test("a cached signed out posture gets the reminder", () => {
  assert.equal(
    applyReach(
      "SessionStart",
      {},
      { ...config, unconfigured: false, signedOut: true },
      {},
      { home: tempHome() }
    ).systemMessage,
    reminder()
  );
});

const settingsCases = [
  ["missing", undefined, {}, true],
  ["enabled", '{"signInReminder":true}', {}, true],
  ["unrelated", '{"usagePing":false}', { DO_NOT_TRACK: "1" }, true],
  ["false", '{"signInReminder":false}', {}, false],
  ["malformed", "{", {}, false],
  ["null", "null", {}, false],
  ["array", "[]", {}, false],
  ["number", "1", {}, false],
  ["non boolean", '{"signInReminder":"true"}', {}, false],
  ["unreadable", "{}", {}, false],
  ...["1", " TrUe ", " YES "].map((value) => [
    `env ${value}`,
    undefined,
    { ARMORIQ_SIGNIN_REMINDER_DISABLED: value },
    false,
  ]),
  ["plugin", undefined, { CLAUDE_PLUGIN_OPTION_DISABLE_SIGNIN_REMINDER: "true" }, false],
];

test("the config resolves each reminder setting independently of ping consent", () => {
  for (const [name, contents, env, enabled] of settingsCases) {
    const home = tempHome();
    mkdirSync(path.join(home, ".armoriq"));
    const file = path.join(home, ".armoriq/settings.json");
    if (contents !== undefined) {
      writeFileSync(file, contents);
      if (name === "unreadable") chmodSync(file, 0);
    }
    withHome(home, () => assert.equal(loadConfig(env).signInReminderEnabled, enabled, name));
  }
});

for (const daemon of [true, false]) {
  test(`the hook uses current reminder settings via ${daemon ? "daemon" : "in process"}`, async (t) => {
    const preloads = tempHome();
    const preload = path.join(preloads, "in-process.mjs");
    writeFileSync(
      preload,
      `import net from 'node:net'; import { syncBuiltinESMExports } from 'node:module'; if (process.argv[1] === ${JSON.stringify(new URL("../scripts/hook-router.mjs", import.meta.url).pathname)}) { net.createConnection = () => { throw new Error('in process test'); }; syncBuiltinESMExports(); }`
    );
    const session = await startHookSession(t, await startBackend(), {
      ARMORIQ_ENV: "production",
      DO_NOT_TRACK: "1",
      ARMORIQ_OBSERVABILITY_DISABLED: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""}${daemon ? "" : ` --import=${preload}`}`,
      ARMORIQ_SIGNIN_REMINDER_DISABLED: "1",
    });
    const settings = path.join(session.env.HOME, ".armoriq/settings.json");
    let context;
    for (const [name, contents, env, enabled] of settingsCases) {
      rmSync(settings, { force: true });
      if (contents !== undefined) {
        writeFileSync(settings, contents);
        if (name === "unreadable") chmodSync(settings, 0);
      }
      session.env.ARMORIQ_SIGNIN_REMINDER_DISABLED = "";
      session.env.CLAUDE_PLUGIN_OPTION_DISABLE_SIGNIN_REMINDER = "";
      Object.assign(session.env, env);
      const result = await session.hook({ hook_event_name: "SessionStart", session_id: name });
      assert.equal(result.systemMessage, enabled ? reminder() : undefined, name);
      context ??= result.hookSpecificOutput.additionalContext;
      assert.equal(result.hookSpecificOutput.additionalContext, context, name);
      assert.equal(context.includes("ArmorClaude is not signed in"), false);
      assert.match(context, /installed but NOT connected/);
      if (enabled) {
        const second = await session.hook({
          hook_event_name: "SessionStart",
          session_id: `${name}-second`,
        });
        assert.equal(second.systemMessage, undefined);
        assert.equal(second.hookSpecificOutput.additionalContext, context);
        rmSync(dirFor(session.env.HOME), { recursive: true, force: true });
      }
    }
    assert.equal(existsSync(path.join(session.env.HOME, ".armoriq/install-id")), false);
    assert.equal(session.stderr.join("").includes("falling back in-process"), !daemon);
  });
}

test("login commands select an executable on PATH at print time and run from another directory", async (t) => {
  const home = tempHome();
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  const log = path.join(home, "argv.json");
  const executable = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`;
  for (const name of ["armoriq", "npx"]) {
    writeFileSync(path.join(bin, name), executable);
    chmodSync(path.join(bin, name), 0o755);
  }
  const previous = process.env.PATH;
  t.after(() => {
    process.env.PATH = previous;
  });
  process.env.PATH = bin;
  const custom = "https://user:private@custom.example.test:8443/path?token=private#hash";
  const messages = [];
  for (const [available, backend, prefix, argv] of [
    [true, STAGING, "armoriq", ["login", "--product", "armorclaude", "--backend", STAGING]],
    [
      false,
      PRODUCTION,
      "npx -y @armoriq/sdk",
      ["-y", "@armoriq/sdk", "login", "--product", "armorclaude", "--backend", PRODUCTION],
    ],
    [
      false,
      custom,
      "npx -y @armoriq/sdk",
      [
        "-y",
        "@armoriq/sdk",
        "login",
        "--product",
        "armorclaude",
        "--backend",
        "https://custom.example.test:8443",
      ],
    ],
  ]) {
    chmodSync(path.join(bin, "armoriq"), available ? 0o755 : 0o644);
    const command = loginCommand(backend);
    assert.equal(statusCommand(), `${prefix} status`);
    assert.equal(
      command,
      `${prefix} login --product armorclaude --backend ${backend === custom ? "'https://custom.example.test:8443'" : backend}`
    );
    assert.ok(notSignedIn(backend).endsWith(command));
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: home,
      env: { ...process.env, HOME: home },
      stdio: "ignore",
    });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), argv);
    messages.push([
      applyReach(
        "SessionStart",
        {},
        { ...config, backendEndpoint: backend },
        {},
        { home: tempHome() }
      ).systemMessage,
      backend === custom ? undefined : reminder(backend),
    ]);
  }
  for (const [actual, expected] of messages) assert.equal(actual, expected);
  for (const backend of [undefined, "not a URL", "https://"])
    assert.equal(loginCommand(backend), "npx -y @armoriq/sdk login --product armorclaude");
  withHome(home, () => assert.equal(loadConfig({}).signInReminderEnabled, true));
});
