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

test("payload follows the contract and excludes session information", (t) => {
  for (const [platform, expectedOs] of Object.entries(contract.osMapping)) {
    for (const [unconfigured, signedOut, expected] of [
      [true, false, false],
      [false, true, false],
      [false, false, true],
    ]) {
      const { sent, deps } = launched(tempHome(t), { platform });
      launchReach(
        "SessionStart",
        {
          cwd: "/private/project-canary",
          hostname: "host-canary",
          tool_name: "tool-canary",
          transcript_path: "/private/transcript-canary",
        },
        { ...config, unconfigured, signedOut },
        deps
      );
      const input = sent[0];
      schema.parse(input.body);
      assert.equal(input.body.os, expectedOs);
      assert.equal(input.body.signedIn, expected);
      assert.equal(input.body.pluginVersion, config.clientVersion.split("/")[1]);
      assert.equal(input.body.environment, "production");
      assert.equal(input.body.hostVersion, null);
      assert.equal(input.body.plugin, "armorclaude");
      assert.equal(input.body.hostAgent, "claude-code");
      assert.deepEqual(input.body.localCounts, []);
      assert.equal(
        new Set(input.body.localCounts.map((row) => row.day)).size,
        input.body.localCounts.length
      );
      assert.ok(
        input.body.localCounts.every(
          (row) => new Date(`${row.day}T00:00:00Z`).toISOString().slice(0, 10) === row.day
        )
      );
      assert.equal(input.transcriptPath, "/private/transcript-canary");
      for (const secret of [
        "project-canary",
        "host-canary",
        "tool-canary",
        "transcript-canary",
        "armorclaude-dev",
      ])
        assert.equal(JSON.stringify(input.body).includes(secret), false);
    }
  }
});

test("worker sends one anonymous request with a three second abort", async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis.AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 3000);
    return controller.signal;
  });
  const requests = [];
  await runWorker(
    workerDeps(t, {
      readTranscript: async () => '{"version":"2.1.325"}\n',
      fetch: async (url, init) => {
        requests.push([url, init]);
        assert.equal(init.signal, controller.signal);
        controller.abort();
        throw controller.signal.reason;
      },
    })
  );
  assert.equal(requests.length, 1);
  const [url, init] = requests[0];
  assert.equal(url, `${origin}/install-pings`);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, { "content-type": "application/json" });
  assert.equal(init.redirect, "error");
  const body = JSON.parse(init.body);
  schema.parse(body);
  assert.equal(body.hostVersion, "2.1.325");
  assert.equal(Object.hasOwn(body, "transcriptPath"), false);
});

for (const result of [204, 500, 429, 302, "error", "timeout"]) {
  test(`worker settles yesterday's counts without retrying after ${result}`, async (t) => {
    const home = tempHome(t);
    const { sent, deps } = launched(home);
    reach.noteReach("PreToolUse", {}, config, denied, {
      ...deps,
      now: () => new Date("2026-11-13T23:59:59.999Z"),
    });
    launchReach("SessionStart", {}, config, deps);
    const expected = [{ day: "2026-11-13", plans: 0, blocked: 1, held: 0 }];
    assert.deepEqual(sent[0].body.localCounts, []);
    assert.equal(readFileSync(countsFile(home, "2026-11-13"), "utf8"), contract.localCountsLine[1]);
    assert.equal(existsSync(`${countsFile(home, "2026-11-13")}.sending`), false);
    if (result === "timeout") {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.method(globalThis.AbortSignal, "timeout", (ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error("timeout")), ms);
        return controller.signal;
      });
    }
    let attempts = 0;
    let body;
    let redirect;
    const running = runWorker(
      workerDeps(t, {
        home,
        input: sent[0],
        fetch: async (_url, init) => {
          attempts += 1;
          redirect = init.redirect;
          body = JSON.parse(init.body);
          if (result === "error") throw new Error("offline");
          if (result === "timeout")
            return new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(init.signal.reason), {
                once: true,
              });
            });
          return { status: result, headers: { location: "https://elsewhere.invalid" } };
        },
      })
    );
    if (result === "timeout") {
      await setImmediate();
      t.mock.timers.tick(3000);
    }
    await running;
    assert.equal(attempts, 1);
    assert.equal(redirect, "error");
    schema.parse(body);
    assert.deepEqual(body.localCounts, expected);
    assert.equal(existsSync(`${countsFile(home, "2026-11-13")}.sending`), false);
    assert.equal(existsSync(countsFile(home, "2026-11-13")), result !== 204);
    launchReach("UserPromptSubmit", {}, config, {
      ...deps,
      now: () => new Date("2026-11-15T00:00:00Z"),
    });
    body = undefined;
    await runWorker(
      workerDeps(t, {
        home,
        input: sent[1],
        fetch: async (_url, init) => {
          body = JSON.parse(init.body);
          return { status: 204 };
        },
      })
    );
    assert.deepEqual(body.localCounts, result === 204 ? [] : expected);
  });
}

test("counts collection keeps at most seven earlier UTC days, skips bad lines and caps each metric", async (t) => {
  const reads = [];
  const originalRead = fs.readFileSync;
  mockFs(t, {
    readFileSync: (file, ...args) => {
      reads.push(String(file));
      return originalRead(file, ...args);
    },
  });
  for (const zero of [false, true]) {
    const home = tempHome(t);
    mkdirSync(countsDir(home), { recursive: true, mode: 0o700 });
    for (let day = 5; day <= 15; day += 1)
      writeFileSync(
        countsFile(home, `2026-11-${String(day).padStart(2, "0")}`),
        contract.localCountsLine[1]
      );
    const invalid = '{\nnull\n{"t":"unknown"}\n{"t":"plan","extra":1}\n';
    writeFileSync(countsFile(home, "2026-11-12"), invalid + contract.localCountsLine.join(""));
    writeFileSync(
      countsFile(home, "2026-11-11"),
      contract.localCountsLine.map((line) => line.repeat(100001)).join("")
    );
    if (zero) writeFileSync(countsFile(home, "2026-11-10"), invalid);
    writeFileSync(
      path.join(countsDir(home), "counts-2026-02-30.ndjson"),
      contract.localCountsLine[0]
    );
    const { sent, deps } = launched(home);
    const before = readdirSync(countsDir(home)).sort();
    reads.length = 0;
    launchReach("SessionStart", {}, config, deps);
    assert.deepEqual(
      reads.filter((file) => file.includes("counts-")),
      []
    );
    assert.deepEqual(
      readdirSync(countsDir(home))
        .filter((name) => name.startsWith("counts-"))
        .sort(),
      before
    );
    let body;
    await runWorker(
      workerDeps(t, {
        home,
        input: sent[0],
        fetch: async (_url, init) => {
          body = JSON.parse(init.body);
          return { status: 204 };
        },
      })
    );
    schema.parse(body);
    const days = ["13", "12", "11", "10", "09", "08", "07"]
      .filter((day) => !zero || day !== "10")
      .map((day) => `2026-11-${day}`);
    assert.deepEqual(
      body.localCounts.map((row) => row.day),
      days
    );
    assert.deepEqual(
      body.localCounts.find((row) => row.day === "2026-11-12"),
      { day: "2026-11-12", plans: 1, blocked: 1, held: 1 }
    );
    assert.deepEqual(
      body.localCounts.find((row) => row.day === "2026-11-11"),
      { day: "2026-11-11", plans: 100000, blocked: 100000, held: 100000 }
    );
    for (const day of ["2026-11-05", "2026-11-06"])
      assert.equal(existsSync(countsFile(home, day)), false);
    for (const day of ["2026-11-14", "2026-11-15", "2026-02-30"])
      assert.equal(
        readFileSync(countsFile(home, day), "utf8"),
        contract.localCountsLine[day === "2026-02-30" ? 0 : 1]
      );
  }
});

for (const result of [204, 500]) {
  test(`leftover sending files and late writers lose no lines after ${result}`, async (t) => {
    const home = tempHome(t);
    mkdirSync(countsDir(home), { recursive: true, mode: 0o700 });
    const file = countsFile(home, "2026-11-13");
    writeFileSync(`${file}.sending`, contract.localCountsLine[0]);
    writeFileSync(file, contract.localCountsLine[2]);
    const stale = `${countsFile(home, "2026-11-06")}.sending`;
    writeFileSync(stale, contract.localCountsLine[0]);
    const { sent, deps } = launched(home);
    launchReach("SessionStart", {}, config, deps);
    let body;
    await runWorker(
      workerDeps(t, {
        home,
        input: sent[0],
        fetch: async (_url, init) => {
          body = JSON.parse(init.body);
          writeFileSync(file, contract.localCountsLine[1], { flag: "a", mode: 0o600 });
          return { status: result };
        },
      })
    );
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(stale.slice(0, -8)), false);
    assert.deepEqual(body.localCounts, [{ day: "2026-11-13", plans: 1, blocked: 0, held: 1 }]);
    assert.equal(existsSync(`${file}.sending`), false);
    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).t)
      .sort();
    assert.deepEqual(lines, result === 204 ? ["blocked"] : ["blocked", "held", "plan"]);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    launchReach("SessionStart", {}, config, {
      ...deps,
      now: () => new Date("2026-11-15T00:00:00Z"),
    });
    body = undefined;
    await runWorker(
      workerDeps(t, {
        home,
        input: sent[1],
        fetch: async (_url, init) => {
          body = JSON.parse(init.body);
          return { status: 204 };
        },
      })
    );
    assert.deepEqual(body.localCounts, [
      {
        day: "2026-11-13",
        plans: result === 204 ? 0 : 1,
        blocked: 1,
        held: result === 204 ? 0 : 1,
      },
    ]);
  });
}

test("worker rechecks opt outs after looking up the host version", async (t) => {
  for (const [source, value] of [
    ["env", "true"],
    ["settings", false],
    ...["1", "true", "yes", "y", "on", " ON "].map((value) => ["userConfig", value]),
  ]) {
    const env = {};
    const home = tempHome(t);
    mkdirSync(countsDir(home), { recursive: true, mode: 0o700 });
    const file = countsFile(home, "2026-11-13");
    writeFileSync(file, contract.localCountsLine[0]);
    const { sent, deps } = launched(home);
    launchReach("SessionStart", {}, config, deps);
    let attempts = 0;
    await runWorker(
      workerDeps(t, {
        env,
        home,
        input: sent[0],
        readTranscript: async () => {
          if (source === "env") env.DO_NOT_TRACK = value;
          if (source === "settings") settings(home, { usagePing: value });
          if (source === "userConfig") env.CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_PING = value;
          return '{"version":"2.1.325"}\n';
        },
        fetch: async () => {
          attempts += 1;
        },
      })
    );
    assert.equal(attempts, 0);
    assert.equal(readFileSync(file, "utf8"), contract.localCountsLine[0]);
    assert.equal(existsSync(`${file}.sending`), false);
  }
});

test("worker ignores a non contract origin before version lookup", async (t) => {
  let reads = 0;
  let requests = 0;
  await runWorker(
    workerDeps(t, {
      input: { ...workerInput(), origin: "http://127.0.0.1:8000" },
      readTranscript: async () => {
        reads += 1;
      },
      fetch: async () => {
        requests += 1;
      },
    })
  );
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

for (const [transcript, cli, expected] of [
  ['{"version":"2.1.325"}\n', "9.9.9 (Claude Code)", "2.1.325"],
  ['bad json\n{"version":"2.1.325-beta.1"}\n', "", "2.1.325-beta.1"],
  ["", "2.1.325 (Claude Code)\n", "2.1.325"],
  ["", "v2.1.325", null],
  ['{"version":"bad"}\n', "", null],
  ['{"version":"1.2.3+' + "x".repeat(70) + '"}\n', "", null],
]) {
  test(`host version ${JSON.stringify([transcript, cli])} becomes ${expected}`, async (t) => {
    let body;
    await runWorker(
      workerDeps(t, {
        readTranscript: async () => transcript,
        execVersion: async () => cli,
        fetch: async (_url, init) => {
          body = JSON.parse(init.body);
        },
      })
    );
    assert.equal(body.hostVersion, expected);
  });
}

test("host lookup shares a one second budget and sending has a hard deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const home = tempHome(t);
  mkdirSync(countsDir(home), { recursive: true, mode: 0o700 });
  const file = countsFile(home, "2026-11-13");
  writeFileSync(file, contract.localCountsLine[0]);
  const { sent, deps } = launched(home);
  launchReach("SessionStart", {}, config, deps);
  let requests = 0;
  let execs = 0;
  const running = runWorker(
    workerDeps(t, {
      home,
      input: sent[0],
      readTranscript: () => new Promise(() => {}),
      execVersion: async () => {
        execs += 1;
        return "1.2.3";
      },
      fetch: async (_url, init) => {
        requests += 1;
        assert.equal(JSON.parse(init.body).hostVersion, null);
        return new Promise(() => {});
      },
    })
  );
  await setImmediate();
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(execs, 0);
  assert.equal(requests, 1);
  t.mock.timers.tick(4000);
  await running;
  assert.equal(readFileSync(file, "utf8"), contract.localCountsLine[0]);
  assert.equal(existsSync(`${file}.sending`), false);
});

test("version lookup errors produce null and still allow one send", async (t) => {
  let body;
  await runWorker(
    workerDeps(t, {
      readTranscript: async () => {
        throw new Error("missing");
      },
      execVersion: async () => {
        throw new Error("not installed");
      },
      fetch: async (_url, init) => {
        body = JSON.parse(init.body);
      },
    })
  );
  assert.equal(body.hostVersion, null);
});

test("the worker script exits silently on invalid input and enforces its stdin deadline", async (t) => {
  const home = tempHome(t);
  const preload = path.join(home, "deadline.mjs");
  writeFileSync(
    preload,
    `const original = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === 5000 ? 0 : ms, ...args);`
  );
  for (const unfinished of [false, true]) {
    const child = spawn(process.execPath, [workerFile], {
      env: {
        ...process.env,
        HOME: home,
        DO_NOT_TRACK: "1",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""}${unfinished ? ` --import=${preload}` : ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = once(child, "exit");
    if (!unfinished) child.stdin.end("{");
    const [code] = await exited;
    child.stdin.destroy();
    assert.equal(code, 0);
    assert.equal(output, "");
  }
});

for (const daemon of [true, false]) {
  test(`SessionStart adds the notice only once via ${daemon ? "daemon" : "in process"}`, async (t) => {
    const preloadHome = tempHome(t);
    const capture = path.join(preloadHome, "worker-input.json");
    const preload = path.join(preloadHome, "capture.mjs");
    writeFileSync(
      preload,
      `import cp from 'node:child_process';
    import net from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    import { writeFileSync } from 'node:fs';
    const real = cp.spawn;
    cp.spawn = function(command, args, options) {
      if (args?.[0] !== ${JSON.stringify(workerFile)}) return real(command, args, options);
      const child = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdin.end = (data) => writeFileSync(${JSON.stringify(capture)}, data);
      child.unref = () => {}; return child;
    };
    if (!${daemon} && process.argv[1] === ${JSON.stringify(new URL("../scripts/hook-router.mjs", import.meta.url).pathname)}) {
      net.createConnection = () => { throw new Error('in process test'); };
    }
    syncBuiltinESMExports();`
    );
    const outputs = [];
    for (const disabled of ["1", "0"]) {
      const backend = await startBackend();
      const session = await startHookSession(t, backend, {
        ARMORIQ_ENV: "production",
        DO_NOT_TRACK: disabled,
        ARMORIQ_OBSERVABILITY_DISABLED: "1",
        ARMORIQ_USAGE_SYNC_DISABLED: "1",
        ARMORIQ_SIGNIN_REMINDER_DISABLED: "1",
        ARMORIQ_USAGE_PING_DISABLED: "0",
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`,
      });
      outputs.push(
        await session.hook({ hook_event_name: "SessionStart", session_id: "reach-session" })
      );
      assert.equal(
        existsSync(path.join(session.env.HOME, ".armoriq/install-id")),
        disabled === "0"
      );
      const second = await session.hook({
        hook_event_name: "SessionStart",
        session_id: "second-reach-session",
      });
      assert.deepEqual(second, outputs[0]);
      assert.equal(
        existsSync(path.join(session.env.HOME, ".armoriq/reach/v1/armorclaude/notice-shown")),
        disabled === "0"
      );
      assert.equal(session.stderr.join("").includes("falling back in-process"), !daemon);
    }
    assert.deepEqual(outputs[1], {
      ...outputs[0],
      systemMessage: [outputs[0].systemMessage, contract.notice].filter(Boolean).join("\n\n"),
    });
    schema.parse(JSON.parse(readFileSync(capture, "utf8")).body);
  });
}

for (const daemon of [true, false]) {
  test(`a signed out blocked hook appends once via ${daemon ? "daemon" : "in process"} and uses the hook's opt out`, async (t) => {
    const preloadHome = tempHome(t);
    const preload = path.join(preloadHome, "in-process.mjs");
    const router = new URL("../scripts/hook-router.mjs", import.meta.url).pathname;
    writeFileSync(
      preload,
      `import net from 'node:net';
      import { syncBuiltinESMExports } from 'node:module';
      if (process.argv[1] === ${JSON.stringify(router)}) {
        net.createConnection = () => { throw new Error('in process test'); };
        syncBuiltinESMExports();
      }`
    );
    const backend = await startBackend();
    const session = await startHookSession(t, backend, {
      ARMORIQ_ENV: "production",
      DO_NOT_TRACK: "1",
      ARMORIQ_USAGE_PING_DISABLED: "0",
      ARMORIQ_OBSERVABILITY_DISABLED: "1",
      ARMORIQ_USAGE_SYNC_DISABLED: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""}${daemon ? "" : ` --import=${preload}`}`,
    });
    const outputs = [];
    for (const disabled of ["1", "0"]) {
      session.env.DO_NOT_TRACK = disabled;
      outputs.push(
        await session.hook({
          hook_event_name: "PreToolUse",
          tool_name: "Write",
          tool_input: {
            file_path: path.join(session.env.HOME, ".armoriq/credentials.json"),
            content: "blocked",
          },
        })
      );
      if (disabled === "1") assert.equal(existsSync(countsDir(session.env.HOME)), false);
    }
    assert.equal(outputs[0].hookSpecificOutput.permissionDecision, "deny");
    assert.deepEqual(outputs[0], outputs[1]);
    const files = readdirSync(countsDir(session.env.HOME)).filter((name) =>
      /^counts-.*\.ndjson$/.test(name)
    );
    assert.equal(files.length, 1);
    assert.equal(
      readFileSync(path.join(countsDir(session.env.HOME), files[0]), "utf8"),
      contract.localCountsLine[1]
    );
    assert.equal(session.stderr.join("").includes("falling back in-process"), !daemon);
  });
}

test("the ping and reminder hook path has p95 under 20 ms across 50 homes with pending counts", (t) => {
  const durations = [];
  for (let i = 0; i < 50; i += 1) {
    const home = tempHome(t);
    mkdirSync(countsDir(home), { recursive: true, mode: 0o700 });
    const pending = countsFile(home, "2026-11-13");
    writeFileSync(pending, contract.localCountsLine[0].repeat(100000));
    const { sent, deps } = launched(home);
    const start = performance.now();
    launchReach("SessionStart", {}, config, deps);
    const output = reach.applyReach(
      "SessionStart",
      {},
      { ...config, signInReminderEnabled: true },
      {},
      deps
    );
    durations.push(performance.now() - start);
    assert.match(output.systemMessage, /ArmorClaude is not signed in/);
    assert.equal(sent.length, 1);
    assert.equal(existsSync(pending), true);
    assert.equal(existsSync(`${pending}.sending`), false);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  t.diagnostic(`ping and reminder p95 across 50 runs: ${p95.toFixed(3)} ms`);
  assert.ok(p95 < 20, `p95 was ${p95.toFixed(3)} ms`);
});
