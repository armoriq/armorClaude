import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import armoriqSdk from "@armoriq/sdk-dev";
import { loadConfig } from "../scripts/lib/config.mjs";
import {
  copyGoldenCredentials,
  GOLDEN_CREDENTIALS,
  loadConfigWithLogins,
  STAGING,
  tempHome,
  withHome,
  writeLoginProfiles,
} from "./helpers/login-profile.mjs";

const { loadProfile } = armoriqSdk;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookRouter = path.join(repoRoot, "scripts", "hook-router.mjs");
const backfill = path.join(repoRoot, "scripts", "backfill.mjs");
const golden = JSON.parse(readFileSync(GOLDEN_CREDENTIALS, "utf8")).profiles;
const LOGIN_KEY = "ak_live_loginprofile00000000000000";
const RELOGIN_NOTICE =
  "ArmorIQ: sign in again to keep sending armorclaude data. Run: armoriq-dev login --product armorclaude --force";

test("ARMORIQ_API_KEY and the API_KEY plugin option are not key sources", () => {
  const env = {
    ARMORIQ_API_KEY: "ak_live_fromenv0000000000000000000",
    CLAUDE_PLUGIN_OPTION_API_KEY: "ak_live_fromoption00000000000000",
  };
  const signedOut = loadConfigWithLogins([], env);
  assert.equal(signedOut.apiKey, "");
  assert.equal(signedOut.unconfigured, true);
  const signedIn = loadConfigWithLogins([{ backend: STAGING, apiKey: LOGIN_KEY }], env);
  assert.equal(signedIn.apiKey, LOGIN_KEY);
});

test("ARMORIQ_ORG_ID does not change the org sent with the login key", () => {
  const config = loadConfigWithLogins(
    [{ backend: STAGING, apiKey: LOGIN_KEY, orgId: "org-of-the-key" }],
    { ARMORIQ_ORG_ID: "org-other" }
  );
  assert.equal(config.apiKey, LOGIN_KEY);
  assert.equal(config.orgId, "org-of-the-key");
});

test("the plugin manifest has no api_key setting", () => {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json")));
  assert.equal(Object.hasOwn(manifest.userConfig, "api_key"), false);
});

test("a credentials file in the old single-login shape is not used", () => {
  const home = tempHome();
  writeLoginProfiles(home, []);
  const file = path.join(home, ".armoriq", "credentials.json");
  writeFileSync(
    file,
    JSON.stringify({ apiKey: LOGIN_KEY, orgId: "org-1", product: "armorclaude", backend: STAGING })
  );
  const config = withHome(home, () => loadConfig({}));
  assert.equal(config.apiKey, "");
  assert.equal(config.orgId, "");
  assert.equal(config.unconfigured, true);
});

test("only the armorclaude profile for the backend armorClaude calls is used", () => {
  const home = copyGoldenCredentials(tempHome());
  const staging = withHome(home, () => loadConfig({}));
  assert.equal(staging.backendEndpoint, STAGING);
  assert.equal(staging.apiKey, golden["armorclaude@staging-api.armoriq.ai"].apiKey);
  assert.equal(staging.orgId, golden["armorclaude@staging-api.armoriq.ai"].orgId);

  const production = withHome(home, () => loadConfig({ ARMORIQ_ENV: "production" }));
  assert.equal(production.apiKey, "", "the staging armorclaude key is not sent to production");
  assert.equal(production.unconfigured, true);

  const local = withHome(home, () =>
    loadConfig({ ARMORIQ_ENV: "local", ARMORIQ_BACKEND_URL: "http://localhost:3000" })
  );
  assert.equal(local.cryptoPolicyEnabled, false, "the default@localhost:3000 agent key is unused");
  assert.equal(local.orgId, "");

  const codexOnly = writeLoginProfiles(tempHome(), [
    { backend: STAGING, product: "armorcodex", apiKey: LOGIN_KEY },
  ]);
  assert.equal(withHome(codexOnly, () => loadConfig({})).apiKey, "");
});

test("armorclaude and armorcodex profiles in one file both load, and loading changes nothing", () => {
  const home = copyGoldenCredentials(tempHome());
  const file = path.join(home, ".armoriq", "credentials.json");
  const before = readFileSync(file);
  const claude = withHome(home, () => loadConfig({}));
  const codex = withHome(home, () => loadProfile({ backend: STAGING, product: "armorcodex" }));
  assert.equal(claude.apiKey, golden["armorclaude@staging-api.armoriq.ai"].apiKey);
  assert.equal(codex.apiKey, golden["armorcodex@staging-api.armoriq.ai"].apiKey);
  assert.notEqual(claude.apiKey, codex.apiKey);
  assert.deepEqual(readFileSync(file), before);
});

const RELOGIN_BODY = {
  statusCode: 403,
  error: "relogin_required",
  reason: "not_personal_workspace",
  message: "This API key can't send tool data. Run: armoriq login --product armorclaude --force",
};
const FORBIDDEN_BODY = { statusCode: 403, error: "Forbidden", message: "nope" };

const GRANTED = {
  lease: {
    captureMode: "metadata",
    contentCaptureAllowed: false,
    revision: 1,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  },
  traces: null,
  tokenUsage: { recorded: 1 },
};
const ROUTES = {
  "/observability/policy/lease": "lease",
  "/v1/traces": "traces",
  "/dashboard/token-usage": "tokenUsage",
};

async function startBackend(refusals) {
  const calls = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const route = ROUTES[req.url];
      const key = req.headers["x-api-key"];
      if (route) calls.push({ route, key });
      const refused = route && key === LOGIN_KEY ? refusals[route] : undefined;
      const body = refused ?? (route ? GRANTED[route] : {});
      res.writeHead(refused ? refused.statusCode : route ? 200 : 404, {
        "content-type": "application/json",
      });
      res.end(body === null ? "" : JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

function hookEnv(home, dataDir, backendUrl) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? "",
    CLAUDE_PLUGIN_DATA: dataDir,
    ARMORCLAUDE_RUNTIME_FILE: path.join(dataDir, "runtime.json"),
    ARMORCLAUDE_POLICY_FILE: path.join(dataDir, "policy.json"),
    ARMORIQ_ENV: "local",
    ARMORIQ_BACKEND_URL: backendUrl,
    ARMORIQ_CSRG_URL: backendUrl,
  };
}

function runScript(script, env, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function runHook(env, payload) {
  const { code, stdout } = await runScript(hookRouter, env, JSON.stringify(payload));
  const lines = stdout.trim().split("\n").filter(Boolean);
  return { code, output: lines.length ? JSON.parse(lines.at(-1)) : null };
}

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const refusalMarked = (dataDir) =>
  readdirSync(dataDir).some((name) => name.startsWith("relogin-required-"));

async function stopDaemon(dataDir) {
  const pidFile = path.join(dataDir, "daemon.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  process.kill(pid, "SIGTERM");
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    10_000,
    "the daemon to exit"
  );
}

function sessionUuid(label) {
  const h = createHash("sha256").update(label).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function writeTranscript(home, label) {
  const sessionId = sessionUuid(label);
  const dir = path.join(home, ".claude", "projects", "-work-project-a");
  mkdirSync(dir, { recursive: true });
  const line = {
    type: "assistant",
    timestamp: "2026-10-08T10:00:00.000Z",
    cwd: "/work/project-a",
    sessionId,
    message: {
      id: `m-${sessionId}`,
      model: "claude-opus-4",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
  const file = path.join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, `${JSON.stringify(line)}\n`);
  return file;
}

async function notices(run, sessionId, events) {
  const shown = [];
  for (const hook_event_name of events) {
    const { code, output } = await runHook(run.env, {
      session_id: sessionId,
      hook_event_name,
      prompt: "list the files",
      transcript_path: run.transcript,
    });
    assert.equal(code, 0, hook_event_name);
    shown.push(output?.systemMessage?.includes(RELOGIN_NOTICE) ?? false);
  }
  return shown;
}

async function withBackend({ daemon, refusals }, fn) {
  const backend = await startBackend(refusals);
  const home = writeLoginProfiles(tempHome(), [{ backend: backend.url, apiKey: LOGIN_KEY }]);
  const dataDir = tempHome();
  if (!daemon) writeFileSync(path.join(dataDir, "profiles"), "not a directory");
  const run = {
    env: hookEnv(home, dataDir, backend.url),
    home,
    dataDir,
    backend,
    transcript: writeTranscript(home, "s-first"),
  };
  try {
    return await fn(run);
  } finally {
    if (daemon) await stopDaemon(dataDir);
    await backend.close();
  }
}

const REFUSALS = {
  "the policy lease": { lease: RELOGIN_BODY },
  "the span export": { traces: RELOGIN_BODY },
  "token usage": { tokenUsage: RELOGIN_BODY },
};

for (const [what, refusals] of Object.entries(REFUSALS)) {
  for (const daemon of [false, true]) {
    const via = daemon ? "through the daemon" : "without the daemon";
    test(`a 403 relogin_required on ${what} prints the sign-in line once per session, ${via}`, async () => {
      await withBackend({ daemon, refusals }, async (run) => {
        const first = await notices(run, "s-first", ["SessionStart", "UserPromptSubmit", "Stop"]);
        await waitFor(() => refusalMarked(run.dataDir), 30_000, `the refusal on ${what}`);
        const [route] = Object.keys(refusals);
        assert.ok(run.backend.calls.some((c) => c.route === route && c.key === LOGIN_KEY));
        first.push(...(await notices(run, "s-first", ["Stop", "Stop"])));
        assert.equal(first.filter(Boolean).length, 1, `shown once in s-first: ${first}`);
        assert.deepEqual(await notices(run, "s-second", ["SessionStart", "Stop"]), [true, false]);

        writeLoginProfiles(run.home, [
          { backend: run.backend.url, apiKey: "ak_live_newloginafterforce0000000" },
        ]);
        const relogged = await notices(run, "s-third", ["SessionStart", "Stop"]);
        assert.deepEqual(relogged, [false, false], "a new login's key carries no old refusal");
      });
    });
  }
}

test("a history sync refused with relogin_required prints the line once and stops", async () => {
  await withBackend({ daemon: false, refusals: { tokenUsage: RELOGIN_BODY } }, async (run) => {
    writeTranscript(run.home, "s-other");
    const { code, stderr } = await runScript(backfill, run.env, "");
    assert.equal(code, 1);
    assert.equal(stderr.split(RELOGIN_NOTICE).length - 1, 1, stderr);
    assert.equal(run.backend.calls.filter((c) => c.route === "tokenUsage").length, 1);
    assert.ok(refusalMarked(run.dataDir));
    assert.deepEqual(await notices(run, "s-after-sync", ["SessionStart", "Stop"]), [true, false]);
  });
});

test("a 403 with another error on the lease, the span export or token usage prints nothing", async () => {
  const refusals = { lease: FORBIDDEN_BODY, traces: FORBIDDEN_BODY, tokenUsage: FORBIDDEN_BODY };
  await withBackend({ daemon: false, refusals }, async (run) => {
    const id = randomUUID();
    const shown = await notices(run, id, ["SessionStart", "UserPromptSubmit", "Stop", "Stop"]);
    const sync = await runScript(backfill, run.env, "");
    assert.ok(!sync.stderr.includes(RELOGIN_NOTICE), sync.stderr);
    shown.push(...(await notices(run, id, ["Stop"])));
    assert.deepEqual(shown, [false, false, false, false, false]);
    assert.ok(run.backend.calls.some((c) => c.route === "lease"));
    assert.ok(run.backend.calls.some((c) => c.route === "tokenUsage"));
    assert.equal(refusalMarked(run.dataDir), false);
  });
});

test("config exposes identity and complete history from its accepted login", () => {
  const home = copyGoldenCredentials(tempHome());
  const doc = JSON.parse(readFileSync(GOLDEN_CREDENTIALS, "utf8"));
  const expected = doc.profiles["armorclaude@staging-api.armoriq.ai"];
  const config = withHome(home, () =>
    loadConfig({ ARMORCLAUDE_USER_ID: "other", ARMORIQ_API_KEY: "ak_test_other" })
  );
  assert.equal(config.userId, expected.userId);
  assert.equal(config.loggedInAt, expected.loggedInAt);
  assert.deepEqual(config.loginHistory, doc.loginHistory["armorclaude@staging-api.armoriq.ai"]);
});

test("config refuses missing or invalid login timestamps without savedAt inference", () => {
  for (const timestamp of [undefined, "invalid", "2026-10-08T12:00:00Z"]) {
    const home = copyGoldenCredentials(tempHome());
    const file = path.join(home, ".armoriq", "credentials.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.profiles["armorclaude@staging-api.armoriq.ai"].loggedInAt = timestamp;
    writeFileSync(file, JSON.stringify(doc));
    const config = withHome(home, () => loadConfig({}));
    assert.equal(config.apiKey, "");
    assert.equal(config.userId, "");
    assert.equal(config.loggedInAt, "");
    assert.equal(config.loginHistory, null);
  }
});
