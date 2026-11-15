import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import {
  buildBody,
  claimDay,
  ensureInstallId,
  environmentFor,
  launchReach,
  pingEnabled,
} from "../scripts/lib/reach.mjs";
import * as reach from "../scripts/lib/reach.mjs";
import { runWorker } from "../scripts/reach-ping.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { withReloginNotice } from "../scripts/lib/relogin.mjs";
import { startBackend, startHookSession } from "./helpers/hook-session.mjs";

const contract = JSON.parse(
  readFileSync(new URL("./fixtures/install-ping-v1.json", import.meta.url))
);
const schema = z.fromJSONSchema(contract.schema);
const reachUrl = new URL("../scripts/lib/reach.mjs", import.meta.url).href;
const workerFile = new URL("../scripts/reach-ping.mjs", import.meta.url).pathname;
const origin = contract.origins.production[0];
const installId = contract.examples.valid[0].installId;
const config = {
  backendEndpoint: origin,
  armoriqEnv: "production",
  clientVersion: "armorclaude/0.2.10",
  unconfigured: true,
  signedOut: false,
  usagePingEnabled: true,
};

function tempHome(t) {
  const home = mkdtempSync(path.join(tmpdir(), "install-ping-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function useHome(t, home) {
  t.mock.method(os, "homedir", () => home);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function countsDir(home, environment = "production") {
  return path.join(home, ".armoriq/reach/v1/armorclaude", environment);
}

function countsFile(home, day = "2026-11-14", environment = "production") {
  return path.join(countsDir(home, environment), `counts-${day}.ndjson`);
}

function mockFs(t, overrides) {
  for (const [name, implementation] of Object.entries(overrides))
    t.mock.method(fs, name, implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

function settings(home, value, readable = true) {
  const dir = path.join(home, ".armoriq");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  writeFileSync(file, value === "malformed" ? "{" : JSON.stringify(value));
  if (!readable) chmodSync(file, 0);
}

function setVector(home, vector) {
  if (Object.hasOwn(vector, "settingsJson")) settings(home, vector.settingsJson);
  else if (vector.settings !== null || vector.settingsReadable === false)
    settings(home, vector.settings ?? {}, vector.settingsReadable !== false);
  const rule = contract.optOut.pluginSettings[vector.plugin];
  return Boolean(rule && vector.pluginConfig?.[rule.key] === rule.disabledValue);
}

function launched(home, overrides = {}) {
  const sent = [];
  return {
    sent,
    deps: {
      home,
      env: {},
      now: () => new Date("2026-11-14T23:59:59.999Z"),
      platform: "darwin",
      spawnWorker: (input) => sent.push(input),
      ...overrides,
    },
  };
}

function workerInput() {
  return {
    origin,
    day: "2026-11-14",
    body: buildBody({
      installId,
      config,
      signedIn: false,
      environment: "production",
      platform: "linux",
    }),
    transcriptPath: "/private/transcript.jsonl",
  };
}

function workerDeps(t, overrides = {}) {
  return {
    input: workerInput(),
    env: {},
    home: tempHome(t),
    now: () => 0,
    readTranscript: async () => "",
    execVersion: async () => "",
    fetch: async () => ({ status: 204 }),
    ...overrides,
  };
}

const planTool = "mcp__armorclaude-policy__register_intent_plan";
const reanchorTool = "mcp__plugin_armorclaude_armorclaude-policy__trust_reanchor";
const textResult = (text) => ({ content: [{ type: "text", text }] });
const denied = { hookSpecificOutput: { permissionDecision: "deny" } };

async function race(t, home, operation) {
  const script = `import { ensureInstallId, launchReach } from ${JSON.stringify(reachUrl)};
    process.send('ready'); process.once('message', () => { ${operation}; process.disconnect(); });`;
  const children = [0, 1].map(() =>
    spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
  );
  t.after(() =>
    children.forEach((child) => {
      if (child.exitCode === null) child.kill();
    })
  );
  const outputs = children.map((child) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    return once(child, "exit").then(([code]) => {
      assert.equal(code, 0);
      return output.trim();
    });
  });
  await Promise.all(children.map((child) => once(child, "message")));
  children.forEach((child) => child.send("go"));
  return Promise.all(outputs);
}

for (const [i, vector] of contract.optOut.testVectors.entries()) {
  test(`opt out contract vector ${i + 1}`, (t) => {
    const home = tempHome(t);
    const pluginDisabled = setVector(home, vector);
    assert.equal(pingEnabled({ env: vector.env, home, pluginDisabled }), vector.enabled);
    if (!vector.plugin || vector.plugin === "armorclaude") {
      useHome(t, home);
      const loaded = loadConfig({
        ...vector.env,
        CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_PING: String(pluginDisabled),
      });
      assert.equal(loaded.usagePingEnabled, vector.enabled);
      assert.equal(loaded.usagePingDisabled, pluginDisabled);
    }
  });
}

test("userConfig disables the ping in the hook config", () => {
  assert.equal(
    loadConfig({ CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_PING: "yes" }).usagePingDisabled,
    true
  );
  assert.equal(
    loadConfig({ CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_PING: "false" }).usagePingDisabled,
    false
  );
  assert.equal(loadConfig({ DO_NOT_TRACK: "1" }).usagePingEnabled, false);
});

for (const [event, input, output, overrides, metric] of [
  ["PreToolUse", {}, denied, {}, "blocked"],
  ["PreToolUse", {}, { hookSpecificOutput: { permissionDecision: "ask" } }, {}, "held"],
  ...[
    (text) => text,
    (text) => JSON.stringify({ message: text }),
    (text) => JSON.stringify(textResult(text)),
    (text) => [{ type: "text", text }],
    (text) => ({ message: text }),
    (text) => ({ structuredContent: { message: text } }),
  ].flatMap((wrap) =>
    [
      [planTool, "Intent registered: 1 steps."],
      [reanchorTool, "ReAnchor recorded. trustId=n/a delta( → )"],
    ].flatMap(([tool_name, success]) =>
      [
        [success, "plan"],
        ["Plan rejected: invalid plan", null],
      ].map(([text, metric]) => [
        "PostToolUse",
        { tool_name, tool_response: wrap(text) },
        null,
        {},
        metric,
      ])
    )
  ),
  ...[undefined, null, {}, [], { message: 1 }, { content: [{ text: null }] }, "{bad json"].map(
    (tool_response) => ["PostToolUse", { tool_name: planTool, tool_response }, null, {}, null]
  ),
  [
    "PostToolUse",
    {
      tool_name: planTool,
      tool_response: textResult(
        "Intent registered: 1 steps. No ArmorIQ backend configured — plan stored locally."
      ),
    },
    null,
    {},
    "plan",
  ],
  [
    "PostToolUse",
    {
      tool_name: reanchorTool,
      tool_response: textResult("ReAnchor recorded. trustId=n/a delta( → )"),
    },
    null,
    { unconfigured: false, signedOut: true },
    "plan",
  ],
  [
    "PostToolUse",
    {
      tool_name: "mcp__plugin_armorclaude_armorclaude-policy__register_intent_plan",
      tool_response: "future success reply",
    },
    null,
    {},
    null,
  ],
  [
    "PostToolUse",
    {
      tool_name: " MCP__ARMORCLAUDE-POLICY__TRUST_REANCHOR ",
      tool_response: textResult("future success reply"),
    },
    null,
    {},
    null,
  ],
  ["PreToolUse", {}, denied, { unconfigured: false }, null],
  ["PreToolUse", {}, denied, { usagePingEnabled: false }, null],
  ["PreToolUse", {}, denied, { backendEndpoint: "http://localhost:8000" }, null],
  ["PreToolUse", {}, denied, { armoriqEnv: "local" }, null],
  ["PreToolUse", {}, { hookSpecificOutput: { permissionDecision: "allow" } }, {}, null],
  ["PreToolUse", {}, null, {}, null],
  ["SessionEnd", {}, denied, {}, null],
  [
    "PostToolUseFailure",
    { tool_name: planTool, tool_response: textResult("Intent registered: 1 steps.") },
    denied,
    {},
    null,
  ],
  [
    "PostToolUse",
    { tool_name: "mcp__evil__register_intent_plan", tool_response: "ok" },
    null,
    {},
    null,
  ],
  [
    "PostToolUse",
    { tool_name: "mcp__armorclaude-policy__trust_delegate", tool_response: "ok" },
    null,
    {},
    null,
  ],
  [
    "PostToolUse",
    { tool_name: planTool, tool_response: textResult("Plan rejected: invalid plan") },
    null,
    {},
    null,
  ],
  [
    "PostToolUse",
    { tool_name: reanchorTool, tool_response: textResult("Plan rejected: invalid plan") },
    null,
    {},
    null,
  ],
  [
    "PostToolUse",
    { tool_name: reanchorTool, tool_response: textResult("Reanchor failed: unknown error") },
    null,
    {},
    null,
  ],
  [
    "PostToolUse",
    {
      tool_name: reanchorTool,
      tool_response: textResult("No active session — nothing to reanchor."),
    },
    null,
    {},
    null,
  ],
  [
    "PostToolUse",
    { tool_name: reanchorTool, tool_response: textResult("No intent token in session state.") },
    null,
    {},
    null,
  ],
]) {
  test(`local counts for ${JSON.stringify([event, input, output, overrides])}`, async (t) => {
    const home = tempHome(t);
    useHome(t, home);
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-14T23:59:59.999Z") });
    const actual = reach.applyReach(event, input, { ...config, ...overrides }, output);
    assert.equal(actual, output);
    if (metric) {
      const file = countsFile(home);
      assert.equal(
        readFileSync(file, "utf8"),
        contract.localCountsLine.find((line) => JSON.parse(line).t === metric)
      );
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
      for (let current = path.dirname(file); current !== home; current = path.dirname(current))
        assert.equal(lstatSync(current).mode & 0o777, 0o700);
    } else assert.equal(existsSync(path.join(home, ".armoriq/reach")), false);
  });
}

test("counting preserves existing messages and hook output", async (t) => {
  const home = tempHome(t);
  useHome(t, home);
  const noticeConfig = {
    ...config,
    apiKey: "ak_test_relogin",
    observabilityEndpoint: origin,
    dataDir: home,
    runtimeFile: path.join(home, "runtime.json"),
  };
  const input = { session_id: "notice-session" };
  assert.equal(await withReloginNotice("PreToolUse", input, noticeConfig, denied), denied);
  for (const [event, value, output] of [
    ["SessionEnd", input, null],
    ["PreToolUse", {}, denied],
  ])
    assert.equal(await withReloginNotice(event, value, noticeConfig, output), output);
  const original = { ...denied, systemMessage: "existing message" };
  assert.equal(await withReloginNotice("PreToolUse", input, noticeConfig, original), original);
  assert.equal(
    await withReloginNotice("PostToolUse", { session_id: "other" }, noticeConfig, null),
    null
  );
  assert.deepEqual(
    await withReloginNotice(
      "SessionStart",
      { session_id: "reach-and-relogin" },
      noticeConfig,
      original
    ),
    {
      ...original,
      systemMessage: `existing message\n\n${contract.notice}`,
    }
  );
});

test("the first SessionStart appends the notice once per home without changing other fields", (t) => {
  for (const output of [
    null,
    Object.freeze({
      systemMessage: "existing message",
      additionalContext: "top level context",
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "model context" },
      continue: true,
    }),
    { systemMessage: "" },
  ]) {
    const home = tempHome(t);
    const original = JSON.parse(JSON.stringify(output));
    const actual = reach.applyReach("SessionStart", {}, config, output, { home });
    assert.deepEqual(actual, {
      ...output,
      systemMessage: output?.systemMessage
        ? `${output.systemMessage}\n\n${contract.notice}`
        : contract.notice,
    });
    assert.deepEqual(output, original);
    assert.equal(actual.hookSpecificOutput, output?.hookSpecificOutput);
    const marker = path.join(home, ".armoriq/reach/v1/armorclaude/notice-shown");
    assert.equal(lstatSync(marker).mode & 0o777, 0o600);
    for (let current = path.dirname(marker); current !== home; current = path.dirname(current))
      assert.equal(lstatSync(current).mode & 0o777, 0o700);
    assert.equal(
      reach.applyReach(
        "SessionStart",
        { session_id: "another-session" },
        { ...config, backendEndpoint: contract.origins.staging[0], unconfigured: false },
        output,
        { home }
      ),
      output
    );
  }
});

for (const [event, overrides] of [
  ["SessionStart", { usagePingEnabled: false }],
  ["SessionStart", { backendEndpoint: "http://localhost:8000" }],
  ["SessionStart", { armoriqEnv: "local" }],
  ["UserPromptSubmit", {}],
  ["PreToolUse", {}],
  ["PostToolUse", {}],
  ["SessionEnd", {}],
]) {
  test(`the notice leaves ${event} unchanged with ${JSON.stringify(overrides)}`, (t) => {
    const home = tempHome(t);
    const output = { systemMessage: "existing message", additionalContext: "model context" };
    assert.equal(
      reach.applyReach(event, {}, { ...config, ...overrides }, output, { home }),
      output
    );
    assert.equal(existsSync(path.join(home, ".armoriq/reach")), false);
  });
}

for (const operation of ["mkdirSync", "openSync", "closeSync"]) {
  test(`notice ${operation} errors leave the output unchanged`, (t) => {
    const home = tempHome(t);
    const original = fs[operation];
    mockFs(t, {
      [operation]: (...args) => {
        if (operation === "closeSync") original(...args);
        throw new Error("notice unavailable");
      },
    });
    const output = { systemMessage: "existing message", additionalContext: "model context" };
    assert.equal(reach.applyReach("SessionStart", {}, config, output, { home }), output);
  });
}

test("counter appends one write per event in its UTC day and stops past 5 MB", (t) => {
  const home = tempHome(t);
  const { deps } = launched(home);
  const writes = [];
  const { writeSync, openSync } = fs;
  mockFs(t, {
    openSync: (file, flags, mode) => {
      assert.ok(flags & fs.constants.O_APPEND);
      return openSync(file, flags, mode);
    },
    writeSync: (fd, line) => {
      writes.push(line);
      return writeSync(fd, line);
    },
  });
  reach.applyReach("PreToolUse", {}, config, denied, deps);
  reach.applyReach("PreToolUse", {}, config, denied, {
    ...deps,
    now: () => new Date("2026-11-15T00:00:00Z"),
  });
  assert.deepEqual(writes, [contract.localCountsLine[1], contract.localCountsLine[1]]);
  assert.equal(readFileSync(countsFile(home, "2026-11-15"), "utf8"), contract.localCountsLine[1]);
  const file = countsFile(home);
  writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));
  reach.applyReach("PreToolUse", {}, config, denied, deps);
  assert.equal(lstatSync(file).size, 5 * 1024 * 1024 + 1);
  assert.equal(writes.length, 2);
});

for (const operation of ["mkdirSync", "openSync", "fstatSync", "writeSync", "closeSync"]) {
  test(`counter ${operation} errors are silent and leave the hook output intact`, async (t) => {
    const home = tempHome(t);
    useHome(t, home);
    const original = fs[operation];
    mockFs(t, {
      [operation]: (...args) => {
        if (operation === "closeSync") original(...args);
        throw new Error("counter unavailable");
      },
    });
    const output = [];
    const stdout = t.mock.method(process.stdout, "write", () => {
      output.push("stdout");
      return true;
    });
    const stderr = t.mock.method(process.stderr, "write", () => {
      output.push("stderr");
      return true;
    });
    const actual = await withReloginNotice("PreToolUse", {}, config, denied);
    stdout.mock.restore();
    stderr.mock.restore();
    assert.equal(actual, denied);
    assert.deepEqual(output, []);
  });
}

test("only exact contract origins select an environment", () => {
  for (const [environment, origins] of Object.entries(contract.origins)) {
    for (const value of origins) {
      assert.equal(environmentFor(value), environment);
      for (const invalid of [
        value.replace("https:", "http:"),
        `${value}:443`,
        `${value}/`,
        `${value}/v1`,
        value.replace("https://", "https://user@"),
        `${value}?a=1`,
        `${value}#fragment`,
      ])
        assert.equal(environmentFor(invalid), null, invalid);
    }
  }
  for (const value of [
    "https://staging.armoriq.ai",
    "http://localhost:8000",
    "http://127.0.0.1:9",
    null,
    "https://API.ARMORIQ.AI",
  ])
    assert.equal(environmentFor(value), null);
});

test("install id is published complete, private, reused, and separate from the sign in device", (t) => {
  const home = tempHome(t);
  const dir = path.join(home, ".armoriq");
  const file = path.join(dir, "install-id");
  const visible = [];
  const { openSync, linkSync } = fs;
  mockFs(t, {
    openSync: (...args) => {
      const fd = openSync(...args);
      if (args[0] === file && args[1] === "wx") visible.push(readFileSync(file, "utf8"));
      return fd;
    },
    linkSync: (...args) => {
      linkSync(...args);
      visible.push(readFileSync(file, "utf8"));
    },
  });
  const id = ensureInstallId(home);
  assert.match(id, new RegExp(contract.schema.properties.installId.pattern));
  assert.deepEqual(visible, [`${id}\n`]);
  assert.equal(readFileSync(file, "utf8"), `${id}\n`);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(ensureInstallId(home), id);
  assert.equal(existsSync(path.join(dir, "device-id")), false);
  assert.deepEqual(readdirSync(dir), ["install-id"]);
});

for (const [code, winner, denied] of [
  ["EEXIST", true, false],
  ["ENOTSUP", false, false],
  ["ENOTSUP", true, false],
  ["EACCES", false, true],
]) {
  test(`install id cleans up after link ${code}, winner ${winner}, denied ${denied}`, (t) => {
    const home = tempHome(t);
    const dir = path.join(home, ".armoriq");
    const file = path.join(dir, "install-id");
    const candidates = [];
    const { openSync } = fs;
    mockFs(t, {
      linkSync: (temp, target) => {
        candidates.push(readFileSync(temp, "utf8"));
        if (winner) writeFileSync(target, `${installId}\n`, { flag: "wx", mode: 0o600 });
        throw Object.assign(new Error("link unavailable"), { code });
      },
      openSync: (...args) => {
        if (denied && args[0] === file && args[1] === "wx")
          throw Object.assign(new Error("create denied"), { code: "EACCES" });
        return openSync(...args);
      },
    });
    const id = ensureInstallId(home);
    assert.equal(candidates.length, 1);
    assert.match(
      candidates[0].slice(0, -1),
      new RegExp(contract.schema.properties.installId.pattern)
    );
    assert.equal(candidates[0].slice(-1), "\n");
    if (denied) {
      assert.equal(id, null);
      assert.deepEqual(readdirSync(dir), []);
    } else {
      if (winner) assert.equal(id, installId);
      else assert.equal(`${id}\n`, candidates[0]);
      assert.equal(readFileSync(file, "utf8"), `${id}\n`);
      assert.equal(lstatSync(file).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(dir), ["install-id"]);
    }
  });
}

test("an interrupted candidate write leaves no install id or temp file", (t) => {
  const home = tempHome(t);
  const { writeFileSync } = fs;
  mockFs(t, {
    writeFileSync: (file, contents, options) => {
      writeFileSync(file, contents.slice(0, 5), options);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    },
  });
  assert.equal(ensureInstallId(home), null);
  assert.deepEqual(readdirSync(path.join(home, ".armoriq")), []);
});

test("a stale install id temp file does not block creation", (t) => {
  const home = tempHome(t);
  const dir = path.join(home, ".armoriq");
  const stale = "install-id.99999.crashed.tmp";
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(path.join(dir, stale), "partial", { mode: 0o600 });
  const id = ensureInstallId(home);
  assert.match(id, new RegExp(contract.schema.properties.installId.pattern));
  assert.equal(readFileSync(path.join(dir, "install-id"), "utf8"), `${id}\n`);
  assert.deepEqual(readdirSync(dir).sort(), ["install-id", stale]);
  assert.equal(readFileSync(path.join(dir, stale), "utf8"), "partial");
});

for (const kind of [
  "symlink",
  "empty",
  "invalid",
  "no newline",
  "extra newline",
  "uppercase",
  "unreadable",
  "directory",
]) {
  test(`an ${kind} install id is left untouched`, (t) => {
    const home = tempHome(t);
    const dir = path.join(home, ".armoriq");
    const file = path.join(dir, "install-id");
    mkdirSync(dir);
    const contents =
      kind === "empty"
        ? ""
        : kind === "invalid"
          ? "not-an-id\n"
          : kind === "no newline"
            ? installId
            : kind === "extra newline"
              ? `${installId}\n\n`
              : `${kind === "uppercase" ? installId.toUpperCase() : installId}\n`;
    if (kind === "symlink") {
      writeFileSync(path.join(home, "target"), contents);
      symlinkSync(path.join(home, "target"), file);
    } else if (kind === "directory") mkdirSync(file);
    else writeFileSync(file, contents, { mode: kind === "unreadable" ? 0 : 0o600 });
    const before = lstatSync(file);
    assert.equal(ensureInstallId(home), null);
    const after = lstatSync(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    if (kind !== "directory") {
      if (kind === "unreadable") chmodSync(file, 0o600);
      assert.equal(readFileSync(file, "utf8"), contents);
    }
    assert.equal(existsSync(path.join(dir, "device-id")), false);
  });
}

test("two processes agree on one install id", async (t) => {
  const home = tempHome(t);
  const ids = await race(t, home, "console.log(ensureInstallId(process.env.HOME))");
  assert.equal(ids[0], ids[1]);
  assert.match(ids[0], new RegExp(contract.schema.properties.installId.pattern));
  assert.deepEqual(readdirSync(path.join(home, ".armoriq")), ["install-id"]);
});

test("a claim keeps its day after failure and prunes only its old dates", (t) => {
  const home = tempHome(t);
  const args = { home, plugin: "armorclaude", environment: "production", day: "2026-11-14" };
  assert.equal(claimDay(args), true);
  assert.equal(claimDay(args), false);
  const dir = path.join(home, ".armoriq/reach/v1/armorclaude/production");
  assert.equal(lstatSync(path.join(dir, "ping-2026-11-14")).mode & 0o777, 0o600);
  for (let current = dir; current !== home; current = path.dirname(current))
    assert.equal(lstatSync(current).mode & 0o777, 0o700);
  for (const name of [
    "ping-2026-10-14",
    "ping-2026-10-15",
    "ping-2026-02-30",
    "counts-2026-10-14.ndjson",
    "ping-2026-12-01",
  ])
    writeFileSync(path.join(dir, name), "");
  assert.equal(claimDay({ ...args, day: "2026-11-15" }), true);
  assert.deepEqual(
    readdirSync(dir).sort(),
    [
      "counts-2026-10-14.ndjson",
      "ping-2026-02-30",
      "ping-2026-11-14",
      "ping-2026-11-15",
      "ping-2026-12-01",
    ].sort()
  );
  assert.equal(claimDay({ ...args, environment: "staging" }), true);
  assert.equal(claimDay({ ...args, plugin: "armorcodex" }), true);
});

test("session and prompt share one UTC daily attempt, including a failed spawn", (t) => {
  const home = tempHome(t);
  let clockReads = 0;
  const { sent, deps } = launched(home, {
    now: () => {
      clockReads += 1;
      return new Date("2026-11-14T23:59:59.999Z");
    },
  });
  assert.equal(launchReach("SessionStart", {}, config, deps), undefined);
  launchReach("UserPromptSubmit", {}, config, deps);
  assert.equal(sent.length, 1);
  assert.equal(clockReads, 2);
  launchReach("UserPromptSubmit", {}, config, {
    ...deps,
    now: () => new Date("2026-11-15T00:00:00.000Z"),
  });
  assert.equal(sent.length, 2);
  launchReach("SessionStart", {}, config, {
    ...deps,
    now: () => new Date("2026-11-13T00:00:00.000Z"),
    spawnWorker: () => {
      throw new Error("spawn failed");
    },
  });
  launchReach("SessionStart", {}, config, {
    ...deps,
    now: () => new Date("2026-11-13T00:00:00.000Z"),
  });
  assert.equal(sent.length, 2);
});

test("two racing hooks spawn only one worker", async (t) => {
  const home = tempHome(t);
  const outputs = await race(
    t,
    home,
    `launchReach('SessionStart', {}, ${JSON.stringify(config)}, {
    home: process.env.HOME, env: {}, now: () => new Date('2026-11-14T00:00:00Z'),
    spawnWorker: () => console.log('spawn')
  })`
  );
  assert.deepEqual(outputs.filter(Boolean), ["spawn"]);
});

test("ineligible hooks leave no install id or reach files", (t) => {
  const vectors = contract.optOut.testVectors.filter((vector) => !vector.enabled);
  for (const vector of vectors) {
    const home = tempHome(t);
    const pluginDisabled = setVector(home, vector);
    const { sent, deps } = launched(home, { env: vector.env });
    launchReach("SessionStart", {}, { ...config, usagePingDisabled: pluginDisabled }, deps);
    assert.equal(sent.length, 0);
    assert.equal(existsSync(path.join(home, ".armoriq/install-id")), false);
    assert.equal(existsSync(path.join(home, ".armoriq/reach")), false);
  }
  for (const [event, overrides] of [
    ["PreToolUse", {}],
    ["PostToolUse", {}],
    ["Stop", {}],
    ["SessionEnd", {}],
    ["UserPromptExpansion", {}],
    ["unknown", {}],
    ["SessionStart", { backendEndpoint: "http://127.0.0.1:8000" }],
    ["SessionStart", { armoriqEnv: "local" }],
  ]) {
    const home = tempHome(t);
    const { sent, deps } = launched(home);
    launchReach(event, {}, { ...config, ...overrides }, deps);
    assert.equal(sent.length, 0);
    assert.equal(existsSync(path.join(home, ".armoriq")), false);
  }
});
