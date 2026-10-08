import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const golden = JSON.parse(readFileSync(GOLDEN_CREDENTIALS, "utf8")).profiles;
const LOGIN_KEY = "ak_live_loginprofile00000000000000";
const RELOGIN_NOTICE =
  "ArmorIQ: sign in again to keep sending armorclaude data. Run: armoriq login --product armorclaude --force";

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

const GRANTED_LEASE = {
  captureMode: "metadata",
  contentCaptureAllowed: false,
  revision: 1,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

async function startLeaseBackend(leaseBody) {
  const keys = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/observability/policy/lease") {
        const key = req.headers["x-api-key"];
        keys.push(key);
        const body = key === LOGIN_KEY ? leaseBody : GRANTED_LEASE;
        res.writeHead(body.statusCode ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    keys,
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

function runHook(env, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookRouter], { env, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.on("error", reject);
    child.on("exit", (code) => {
      const lines = stdout.trim().split("\n").filter(Boolean);
      resolve({ code, output: lines.length ? JSON.parse(lines.at(-1)) : null });
    });
    child.stdin.end(JSON.stringify(payload));
  });
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

async function notices(env, sessionId, events) {
  const shown = [];
  for (const hook_event_name of events) {
    const { code, output } = await runHook(env, {
      session_id: sessionId,
      hook_event_name,
      prompt: "list the files",
    });
    assert.equal(code, 0, hook_event_name);
    shown.push(output?.systemMessage?.includes(RELOGIN_NOTICE) ?? false);
  }
  return shown;
}

async function withRefusingBackend({ daemon, leaseBody }, fn) {
  const backend = await startLeaseBackend(leaseBody);
  const home = writeLoginProfiles(tempHome(), [{ backend: backend.url, apiKey: LOGIN_KEY }]);
  const dataDir = tempHome();
  if (!daemon) writeFileSync(path.join(dataDir, "profiles"), "not a directory");
  try {
    return await fn({ env: hookEnv(home, dataDir, backend.url), home, dataDir, backend });
  } finally {
    if (daemon) await stopDaemon(dataDir);
    await backend.close();
  }
}

for (const daemon of [false, true]) {
  const via = daemon ? "through the daemon" : "without the daemon";
  test(`a 403 relogin_required on the policy lease prints the sign-in line once per session, ${via}`, async () => {
    await withRefusingBackend({ daemon, leaseBody: RELOGIN_BODY }, async (run) => {
      await notices(run.env, "s-first", ["SessionStart"]);
      await waitFor(() => refusalMarked(run.dataDir), 15_000, "the refused lease");
      assert.deepEqual([...new Set(run.backend.keys)], [LOGIN_KEY]);
      const first = await notices(run.env, "s-first", ["UserPromptSubmit", "Stop", "Stop"]);
      assert.deepEqual(first, [true, false, false]);
      const second = await notices(run.env, "s-second", ["SessionStart", "Stop"]);
      assert.deepEqual(second, [true, false]);

      writeLoginProfiles(run.home, [
        { backend: run.backend.url, apiKey: "ak_live_newloginafterforce0000000" },
      ]);
      const relogged = await notices(run.env, "s-third", ["SessionStart", "Stop"]);
      assert.deepEqual(relogged, [false, false], "a new login's key carries no old refusal");
    });
  });
}

test("a 403 with another error does not print the sign-in line", async () => {
  const forbidden = { statusCode: 403, error: "Forbidden", message: "nope" };
  await withRefusingBackend({ daemon: false, leaseBody: forbidden }, async (run) => {
    const id = randomUUID();
    await notices(run.env, id, ["SessionStart"]);
    await waitFor(() => run.backend.keys.length > 0, 15_000, "the lease request");
    assert.deepEqual(await notices(run.env, id, ["UserPromptSubmit", "Stop"]), [false, false]);
    assert.equal(refusalMarked(run.dataDir), false);
  });
});
