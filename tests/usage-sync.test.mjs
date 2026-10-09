import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../scripts/lib/config.mjs";
import { randomUUID } from "node:crypto";
import armoriqSdk from "@armoriq/sdk-dev";
import { loadConfigWithLogins, STAGING, withHome } from "./helpers/login-profile.mjs";
import { dispatchViaDaemon } from "../scripts/lib/daemon-client.mjs";
import {
  loadRuntimeState,
  saveRuntimeState,
  upsertSession,
} from "../scripts/lib/runtime-state.mjs";
import { classifyTranscripts } from "../scripts/lib/transcripts.mjs";
import { writeJson } from "../scripts/lib/fs-store.mjs";
import { loadSyncState, syncUsage } from "../scripts/lib/usage-sync.mjs";
import {
  launchUsageSync,
  requestUsageSync,
  syncBasePath,
  userStatePath,
} from "../scripts/lib/usage-sync-launch.mjs";

const SYNC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "usage-sync.mjs"
);
const DAEMON = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "daemon.mjs"
);
const ROUTER = path.join(path.dirname(DAEMON), "hook-router.mjs");
const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S2 = "aaaaaaaa-0000-4000-8000-000000000002";
const S3 = "aaaaaaaa-0000-4000-8000-000000000003";
const S4 = "aaaaaaaa-0000-4000-8000-000000000004";

const assistant = (id, timestamp, input, model = "claude-opus") => ({
  type: "assistant",
  cwd: "/work/repo-a",
  timestamp,
  requestId: `req-${id}`,
  message: { id, model, usage: { input_tokens: input, output_tokens: 0 } },
});

function writeTree(root, files) {
  for (const [rel, lines] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, lines.map((l) => JSON.stringify(l)).join("\n"));
  }
}

function fixtureHome() {
  const home = mkdtempSync(path.join(tmpdir(), "ac-usage-sync-"));
  const history = [
    assistant("m1", "2026-09-20T09:00:00Z", 10),
    assistant("m2", "2026-09-20T09:01:00Z", 20),
  ];
  writeTree(path.join(home, ".claude", "projects", "-work-repo-a"), {
    [`${S1}.jsonl`]: history,
    [`${S1}/subagents/agent-a1.jsonl`]: [assistant("s1", "2026-09-20T09:02:00Z", 100)],
    [`${S1}/subagents/workflows/wf_1/agent-b1.jsonl`]: [
      assistant("w1", "2026-09-21T09:00:00Z", 1000),
    ],
    [`${S1}/subagents/workflows/wf_1/journal.jsonl`]: [{ type: "started", agentId: "b1" }],
    [`${S1}/subagents/${S3}.jsonl`]: [assistant("u1", "2026-09-20T09:03:00Z", 3)],
    [`${S2}.jsonl`]: [...history, assistant("m3", "2026-09-21T10:00:00Z", 7)],
    ["notes.jsonl"]: [assistant("x1", "2026-09-21T10:00:00Z", 5000)],
  });
  return home;
}

test("classifyTranscripts sorts main, subagent, journal and other files", async () => {
  const home = fixtureHome();
  const projects = path.join(home, ".claude", "projects");
  const groups = await classifyTranscripts(projects);
  const rel = (files) => files.map((f) => path.relative(projects, f)).sort();
  assert.deepEqual(rel(groups.main), [`-work-repo-a/${S1}.jsonl`, `-work-repo-a/${S2}.jsonl`]);
  assert.deepEqual(rel(groups.subagent), [
    `-work-repo-a/${S1}/subagents/${S3}.jsonl`,
    `-work-repo-a/${S1}/subagents/agent-a1.jsonl`,
    `-work-repo-a/${S1}/subagents/workflows/wf_1/agent-b1.jsonl`,
  ]);
  assert.deepEqual(rel(groups.journal), [
    `-work-repo-a/${S1}/subagents/workflows/wf_1/journal.jsonl`,
  ]);
  assert.deepEqual(rel(groups.other), ["-work-repo-a/notes.jsonl"]);
});

function projectsOf(home) {
  return path.join(home, ".claude", "projects");
}

async function run(home, state, opts = {}) {
  const rows = [];
  const report = await syncUsage({
    projectsDir: projectsOf(home),
    state,
    post: async (row) => {
      rows.push(row);
      return { ok: opts.fail ? !opts.fail(row) : true };
    },
    ...opts,
  });
  return { rows, report };
}

function assertHourRow(row) {
  assert.match(row.usageDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Number.isInteger(row.usageHour) && row.usageHour >= 0 && row.usageHour <= 23);
}

const summary = (rows) =>
  rows.map((r) => [r.sessionId, r.usageDate, r.usageHour, r.entries[0].inputTokens]).sort();

function append(home, rel, line) {
  appendFileSync(path.join(projectsOf(home), "-work-repo-a", rel), "\n" + JSON.stringify(line));
}

test("first run posts every session-hour once, subagents folded into their session", async () => {
  const home = fixtureHome();
  const { rows, report } = await run(home, await loadSyncState(path.join(home, "none.json")));
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", 9, 133],
    [S1, "2026-09-21", 9, 1000],
    [S2, "2026-09-21", 10, 7],
  ]);
  for (const row of rows) assertHourRow(row);
  assert.equal(report.changed, 2);
  assert.equal(report.read, 2);
  assert.equal(report.sessionHours, 3);
  assert.equal(report.tokens, 1140);
  assert.deepEqual(
    report.notRead.map((f) => path.basename(f)),
    ["notes.jsonl"]
  );
});

test("a second run with no file changes reads and posts nothing", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  await run(home, state);
  const { rows, report } = await run(home, state);
  assert.deepEqual(rows, []);
  assert.equal(report.changed, 0);
  assert.equal(report.read, 0);
});

test("an appended transcript re-posts only its changed hours and still skips forked history", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  await run(home, state);
  append(home, `${S2}.jsonl`, assistant("m4", "2026-09-22T08:00:00Z", 40));
  const first = await run(home, state);
  assert.deepEqual(summary(first.rows), [[S2, "2026-09-22", 8, 40]]);
  assert.equal(first.report.read, 1);

  append(home, `${S1}/subagents/agent-a1.jsonl`, assistant("s2", "2026-09-21T11:00:00Z", 9));
  const second = await run(home, state);
  assert.deepEqual(summary(second.rows), [[S1, "2026-09-21", 11, 9]]);
});

test("a changed transcript whose totals did not change posts nothing", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  await run(home, state);
  append(home, `${S2}.jsonl`, { type: "user", timestamp: "2026-09-21T10:05:00Z" });
  const { rows, report } = await run(home, state);
  assert.equal(report.read, 1);
  assert.deepEqual(rows, []);
});

test("a model that vanishes from a session-hour is posted with zero tokens", async () => {
  const home = fixtureHome();
  const dir = path.join(projectsOf(home), "-work-repo-a");
  writeTree(dir, {
    [`${S2}.jsonl`]: [
      assistant("v1", "2026-09-22T09:00:00Z", 10),
      assistant("v2", "2026-09-22T09:01:00Z", 20, "claude-sonnet"),
      assistant("v3", "2026-09-23T09:00:00Z", 5, "claude-sonnet"),
    ],
  });
  const state = await loadSyncState(path.join(home, "none.json"));
  await run(home, state);
  writeTree(dir, {
    [`${S2}.jsonl`]: [
      assistant("v1", "2026-09-22T09:00:00Z", 10),
      assistant("v4", "2026-09-22T09:02:00Z", 1),
    ],
  });
  const { rows } = await run(home, state);
  const models = (row) => row.entries.map((e) => [e.model, e.inputTokens]);
  assert.deepEqual(
    rows.map((r) => [r.sessionId, r.usageDate, r.usageHour, models(r)]),
    [
      [
        S2,
        "2026-09-22",
        9,
        [
          ["claude-opus", 11],
          ["claude-sonnet", 0],
        ],
      ],
      [S2, "2026-09-23", 9, [["claude-sonnet", 0]]],
    ]
  );
  for (const e of rows.flatMap((r) => r.entries).filter((e) => e.model === "claude-sonnet")) {
    assert.deepEqual([e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens], [0, 0, 0]);
  }
  const again = await run(home, state);
  assert.equal(again.report.changed, 0);
  assert.deepEqual(again.rows, []);
});

test("files under subagents/ are never posted as sessions", async () => {
  const home = fixtureHome();
  const { rows } = await run(home, await loadSyncState(path.join(home, "none.json")));
  assert.deepEqual([...new Set(rows.map((r) => r.sessionId))].sort(), [S1, S2]);
});

test("a failed hour is retried on the next run", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  const failed = await run(home, state, { fail: (row) => row.sessionId === S2 });
  assert.equal(failed.report.failed, 1);
  const retry = await run(home, state);
  assert.deepEqual(summary(retry.rows), [[S2, "2026-09-21", 10, 7]]);
});

test("sessions the plugin saw post armored, and stay armored", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  const first = await run(home, state, { isArmored: (id) => id === S1 });
  assert.deepEqual([...new Set(first.rows.map((r) => `${r.sessionId}:${r.armored}`))].sort(), [
    `${S1}:true`,
    `${S2}:false`,
  ]);
  append(home, `${S1}.jsonl`, assistant("m5", "2026-09-23T08:00:00Z", 1));
  const later = await run(home, state);
  assert.deepEqual(
    later.rows.map((r) => [r.sessionId, r.armored]),
    [[S1, true]]
  );
});

test("a run past its deadline leaves the rest for the next run", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  const late = await run(home, state, { deadline: Date.now() - 1 });
  assert.deepEqual(late.rows, []);
  assert.equal(late.report.left, 2);
  const next = await run(home, state);
  assert.equal(next.rows.length, 3);
});

function sessionHome(lines, subagents = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "ac-usage-hours-"));
  const files = { [`${S1}.jsonl`]: lines };
  for (const [name, sub] of Object.entries(subagents)) files[`${S1}/subagents/${name}`] = sub;
  writeTree(path.join(projectsOf(home), "-work-repo-a"), files);
  return home;
}

const byHour = (rows) =>
  rows.map((r) => [r.usageDate, r.usageHour, r.entries.map((e) => [e.model, e.inputTokens])]);

test("messages either side of an hour boundary post as two hours", async () => {
  const home = sessionHome([
    assistant("h1", "2026-09-20T09:59:59.999Z", 4),
    assistant("h2", "2026-09-20T10:00:00.000Z", 6),
    assistant("h3", "2026-09-20T10:59:00Z", 1),
  ]);
  const { rows } = await run(home, await loadSyncState(path.join(home, "none.json")));
  assert.deepEqual(byHour(rows), [
    ["2026-09-20", 9, [["claude-opus", 4]]],
    ["2026-09-20", 10, [["claude-opus", 7]]],
  ]);
});

test("UTC midnight splits the date, and an offset timestamp files under its UTC hour", async () => {
  const home = sessionHome([
    assistant("d1", "2026-09-20T23:59:59Z", 2),
    assistant("d2", "2026-09-21T00:00:00Z", 3),
    assistant("d3", "2026-09-21T01:30:00+02:00", 5),
    assistant("d4", "2026-09-21T00:10:00", 7),
  ]);
  const { rows } = await run(home, await loadSyncState(path.join(home, "none.json")));
  assert.deepEqual(byHour(rows), [
    ["2026-09-20", 23, [["claude-opus", 7]]],
    ["2026-09-21", 0, [["claude-opus", 10]]],
  ]);
});

test("a model that leaves one hour is zeroed in that hour only", async () => {
  const lines = [
    assistant("z1", "2026-09-22T09:00:00Z", 10),
    assistant("z2", "2026-09-22T09:10:00Z", 20, "claude-sonnet"),
    assistant("z3", "2026-09-22T10:00:00Z", 30, "claude-sonnet"),
  ];
  const home = sessionHome(lines);
  const state = await loadSyncState(path.join(home, "none.json"));
  await run(home, state);
  writeTree(path.join(projectsOf(home), "-work-repo-a"), {
    [`${S1}.jsonl`]: [lines[0], lines[2]],
  });
  const { rows } = await run(home, state);
  assert.deepEqual(byHour(rows), [
    [
      "2026-09-22",
      9,
      [
        ["claude-opus", 10],
        ["claude-sonnet", 0],
      ],
    ],
  ]);
  assert.deepEqual(
    state.sessions[path.join(projectsOf(home), "-work-repo-a", `${S1}.jsonl`)].hours,
    {
      "2026-09-22T09": { "claude-opus": 10 },
      "2026-09-22T10": { "claude-sonnet": 30 },
    }
  );
});

test("subagent usage folds into its session under each message's own hour", async () => {
  const home = sessionHome([assistant("f1", "2026-09-20T09:00:00Z", 1)], {
    "agent-a.jsonl": [
      assistant("fa", "2026-09-20T09:30:00Z", 10),
      assistant("fb", "2026-09-20T11:05:00Z", 100),
    ],
    "workflows/wf_1/agent-b.jsonl": [assistant("fc", "2026-09-20T11:55:00Z", 1000, "claude-haiku")],
  });
  const { rows } = await run(home, await loadSyncState(path.join(home, "none.json")));
  assert.deepEqual(
    rows.map((r) => r.sessionId),
    [S1, S1]
  );
  assert.deepEqual(byHour(rows), [
    ["2026-09-20", 9, [["claude-opus", 11]]],
    [
      "2026-09-20",
      11,
      [
        ["claude-opus", 100],
        ["claude-haiku", 1000],
      ],
    ],
  ]);
});

test("a re-run from the saved state file posts nothing", async () => {
  const home = fixtureHome();
  const statePath = path.join(home, "state.json");
  const state = await loadSyncState(statePath);
  const first = await run(home, state);
  assert.equal(first.rows.length, 3);
  await writeJson(statePath, state);
  const again = await run(home, await loadSyncState(statePath));
  assert.deepEqual(again.rows, []);
  assert.equal(again.report.changed, 0);
});

const HOUR_400 = "usageHour must be an integer from 0 to 23 (UTC hour of usageDate)";

test("failed posts are counted once per distinct status and reason, with the first session-hour", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  const answers = {
    [S1]: { ok: false, status: 400, reason: HOUR_400 },
    [S2]: { ok: false, reason: "connect ECONNREFUSED 127.0.0.1:3000" },
  };
  const report = await syncUsage({
    projectsDir: projectsOf(home),
    state,
    post: async (row) => answers[row.sessionId],
  });
  assert.equal(report.failed, 3);
  assert.deepEqual(report.failures, [
    {
      sessionId: S1,
      usageDate: "2026-09-20",
      usageHour: 9,
      status: 400,
      reason: HOUR_400,
      count: 2,
    },
    {
      sessionId: S2,
      usageDate: "2026-09-21",
      usageHour: 10,
      reason: "connect ECONNREFUSED 127.0.0.1:3000",
      count: 1,
    },
  ]);
  assert.deepEqual(state.sessions, {});
});

test("an unreachable backend ends the run after one post and leaves every session for the next run", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  const calls = [];
  const down = await syncUsage({
    projectsDir: projectsOf(home),
    state,
    post: async (row) => {
      calls.push(row);
      return { ok: false, unreachable: true, reason: "connect ECONNREFUSED 127.0.0.1:9" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(down.failed, 1);
  assert.equal(down.left, 2);
  assert.deepEqual(
    down.failures.map((f) => [f.unreachable, f.reason, f.count]),
    [[true, "connect ECONNREFUSED 127.0.0.1:9", 1]]
  );
  assert.deepEqual(state.sessions, {});

  const { rows } = await run(home, state);
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", 9, 133],
    [S1, "2026-09-21", 9, 1000],
    [S2, "2026-09-21", 10, 7],
  ]);
});

test("an unreachable backend after some posts keeps the sessions already posted", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  let n = 0;
  const report = await syncUsage({
    projectsDir: projectsOf(home),
    state,
    post: async () =>
      ++n <= 2 ? { ok: true } : { ok: false, unreachable: true, reason: "socket hang up" },
  });
  assert.equal(n, 3);
  assert.equal(report.sessionHours, 2);
  assert.equal(report.left, 1);
  assert.deepEqual(
    Object.keys(state.sessions).map((f) => path.basename(f)),
    [`${S1}.jsonl`]
  );
});

test("a failed post with no reason is still reported", async () => {
  const home = fixtureHome();
  const report = await syncUsage({
    projectsDir: projectsOf(home),
    state: await loadSyncState(path.join(home, "none.json")),
    post: async () => ({ ok: false, status: 503 }),
  });
  assert.deepEqual(
    report.failures.map((f) => [f.status, f.reason, f.count]),
    [[503, "no reason given", 3]]
  );
});

function cli(home, args) {
  return spawnSync(process.execPath, [SYNC, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ARMORIQ_DEVICE_ID_PATH: path.join(home, "device-id"),
      CLAUDE_PLUGIN_DATA: path.join(home, "data"),
    },
  });
}

test("usage-sync --dry-run prints each row, then finds nothing changed", () => {
  const home = fixtureHome();
  const first = cli(home, ["--dry-run"]);
  assert.equal(first.status, 0, first.stderr);
  const rows = first.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", 9, 133],
    [S1, "2026-09-21", 9, 1000],
    [S2, "2026-09-21", 10, 7],
  ]);
  for (const row of rows) {
    assert.equal(row.product, "armorclaude");
    assertHourRow(row);
  }
  assert.match(first.stderr, /2 session\(s\) under .*\(3 subagent, 1 journal, 1 other file\(s\)\)/);
  assert.match(first.stderr, /2 changed, 2 read; would post 3 session-hour\(s\) \(1140 tokens\)/);
  assert.match(first.stderr, /not read .*notes\.jsonl/);

  const second = cli(home, ["--dry-run"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
  assert.match(second.stderr, /0 changed, 0 read; would post 0 session-hour\(s\) \(0 tokens\)/);
});

test("usage-sync without an API key posts nothing", () => {
  const home = fixtureHome();
  const res = cli(home, []);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /no API key, nothing synced/);
});

const keyOf = (req) =>
  /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? req.headers["x-api-key"];
const userOf = (key) => `user-of-${key}`;

function fakeBackend(answer = () => [200, { ok: true }]) {
  const posts = [];
  const postedBy = [];
  const history = { requests: new Map(), done: [], failRead: false, failDone: false };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let status = 200;
      let reply = { ok: true };
      const key = keyOf(req);
      if (req.method === "POST" && req.url === "/iap/validate-key") {
        [status, reply] = key?.startsWith("ak_test_unknown")
          ? [401, {}]
          : [200, key?.startsWith("ak_test_nouser") ? {} : { userId: userOf(key) }];
      } else if (req.method === "GET" && req.url.startsWith("/api-keys/device-history-sync?")) {
        [status, reply] = history.failRead
          ? [500, {}]
          : [200, { requestedAt: history.requests.get(userOf(key)) ?? null }];
      } else if (req.method === "POST" && req.url === "/api-keys/device-history-sync/done") {
        const done = { user: userOf(key), ...JSON.parse(body) };
        history.done.push({ ...done, failed: history.failDone });
        if (history.failDone) [status, reply] = [503, {}];
        else if (history.requests.get(done.user) === done.requestedAt)
          history.requests.delete(done.user);
      } else if (req.method === "POST" && req.url === "/dashboard/token-usage") {
        posts.push(JSON.parse(body));
        postedBy.push(userOf(key));
        return Promise.resolve(answer(posts.at(-1))).then((answered) => {
          if (!answered) return req.socket.destroy();
          res.writeHead(answered[0], { "content-type": "application/json" });
          res.end(JSON.stringify(answered[1]));
        });
      }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, posts, postedBy, history, port: server.address().port })
    )
  );
}

const userState = (dataDir, port, key) =>
  userStatePath(dataDir, {
    backend: `http://127.0.0.1:${port}`,
    product: "armorclaude",
    userId: userOf(key),
  });

async function until(check, what, timeoutMs = 20_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const readLastRun = (statePath) => {
  try {
    return JSON.parse(readFileSync(statePath, "utf8")).lastRun?.at;
  } catch {
    return undefined;
  }
};

const pluginEnv = (home, dataDir, port, apiKey = "ak_test_usage_sync_stop") => (
  signedIn(home, port, apiKey),
  {
    PATH: process.env.PATH,
    HOME: home,
    ARMORCLAUDE_DATA_DIR: dataDir,
    ARMORCLAUDE_DEBUG: "false",
    ARMORCLAUDE_USE_SDK_INTENT: "false",
    ARMORIQ_ENV: "local",
    ARMORIQ_BACKEND_URL: `http://127.0.0.1:${port}`,
    ARMORIQ_CSRG_URL: `http://127.0.0.1:${port}`,
    ARMORIQ_DEVICE_ID_PATH: path.join(home, "device-id"),
  }
);

test("a Stop through the daemon triggers the sync, the only writer of a forked session's rows", async () => {
  const home = fixtureHome();
  const dataDir = path.join(home, "data");
  const { server, posts, port } = await fakeBackend();
  const statePath = userState(dataDir, port, "ak_test_usage_sync_stop");
  const env = pluginEnv(home, dataDir, port);
  mkdirSync(dataDir, { recursive: true });
  const runtimeFile = path.join(dataDir, "runtime.json");
  const runtime = await loadRuntimeState(runtimeFile);
  upsertSession(runtime, S2, { lastPrompt: "p" });
  await saveRuntimeState(runtimeFile, runtime);
  const daemon = spawn(process.execPath, [DAEMON], { stdio: "ignore", env, cwd: dataDir });
  try {
    await until(() => existsSync(path.join(dataDir, "daemon.sock")), "the daemon socket");
    const config = loadConfig(env);
    const stop = (sessionId) =>
      dispatchViaDaemon({
        event: "Stop",
        input: {
          hook_event_name: "Stop",
          session_id: sessionId,
          transcript_path: path.join(projectsOf(home), "-work-repo-a", `${sessionId}.jsonl`),
        },
        config,
      });
    const settled = (after) => () =>
      readLastRun(statePath) !== after && !existsSync(`${syncBasePath(dataDir)}.lock`);

    await stop(S2);
    await until(settled(undefined), "the first sync pass");
    const rows = (list) =>
      list
        .map((p) => [p.sessionId, p.usageDate, p.usageHour, p.entries[0].inputTokens, p.armored])
        .sort();
    const expected = [
      [S1, "2026-09-20", 9, 133, false],
      [S1, "2026-09-21", 9, 1000, false],
      [S2, "2026-09-21", 10, 7, true],
    ];
    assert.deepEqual(rows(posts), expected);

    const firstRun = readLastRun(statePath);
    append(home, `${S2}.jsonl`, assistant("m4", "2026-09-21T10:30:00Z", 40));
    await stop(S2);
    await until(settled(firstRun), "the pass after a new turn");
    assert.deepEqual(rows(posts), [...expected, [S2, "2026-09-21", 10, 47, true]].sort());

    const secondRun = readLastRun(statePath);
    await stop(S2);
    await stop(S1);
    await until(settled(secondRun), "the pass after turns that changed nothing");
    assert.equal(posts.length, 4);
  } finally {
    daemon.kill("SIGTERM");
    server.close();
  }
});

test("an in-process Stop, with no daemon reachable, triggers the sync", async () => {
  const home = fixtureHome();
  const dataDir = path.join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  // The daemon exits on startup when profiles is a file, so the hook runs in-process.
  writeFileSync(path.join(dataDir, "profiles"), "not a directory");
  const { server, posts, port } = await fakeBackend();
  const statePath = userState(dataDir, port, "ak_test_usage_sync_stop");
  try {
    const hook = spawn(process.execPath, [ROUTER], { env: pluginEnv(home, dataDir, port) });
    const exited = new Promise((resolve) => hook.once("exit", resolve));
    hook.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: S2 }));
    assert.equal(await exited, 0);
    await until(
      () => readLastRun(statePath) && !existsSync(`${syncBasePath(dataDir)}.lock`),
      "the sync pass"
    );
    assert.equal(existsSync(path.join(dataDir, "daemon.sock")), false);
    assert.equal(posts.length, 3);
  } finally {
    server.close();
  }
});

test("the sync's log, request marker and state are owner-only, and 0644 ones are tightened", async () => {
  const home = fixtureHome();
  const dataDir = path.join(home, "data");
  const { server, posts, port } = await fakeBackend();
  const statePath = userState(dataDir, port, "ak_test_usage_sync_stop");
  mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o755 });
  chmodSync(dataDir, 0o755);
  writeFileSync(path.join(dataDir, "profiles"), "not a directory");
  const files = [
    path.join(dataDir, "usage-sync.log"),
    `${syncBasePath(dataDir)}.request`,
    statePath,
  ];
  for (const file of files) {
    writeFileSync(file, file === statePath ? "{}" : "");
    chmodSync(file, 0o644);
  }
  try {
    const hook = spawn(process.execPath, [ROUTER], { env: pluginEnv(home, dataDir, port) });
    const exited = new Promise((resolve) => hook.once("exit", resolve));
    hook.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: S2 }));
    assert.equal(await exited, 0);
    await until(
      () => readLastRun(statePath) && !existsSync(`${syncBasePath(dataDir)}.lock`),
      "the sync pass"
    );
    assert.equal(posts.length, 3);
    const mode = (file) => statSync(file).mode & 0o777;
    for (const file of files) assert.equal(mode(file), 0o600, file);
    assert.equal(mode(dataDir), 0o700);
    assert.equal(mode(path.dirname(statePath)), 0o700);
  } finally {
    server.close();
  }
});

const KEY = "ak_test_usage_sync_toggle";
const OBS_OFF = { CLAUDE_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "true" };
const SYNC_OFF = { CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "true" };
const TOGGLES = [
  ["observability off", OBS_OFF],
  ["usage sync off", SYNC_OFF],
  ["both off", { ...OBS_OFF, ...SYNC_OFF }],
];

test("usageSyncEnabled needs observability on and disable_usage_sync unset", () => {
  const cases = [
    [{}, true, true],
    [
      {
        CLAUDE_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "false",
        CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "false",
      },
      true,
      true,
    ],
    [OBS_OFF, false, false],
    [SYNC_OFF, true, false],
    [{ ...OBS_OFF, ...SYNC_OFF }, false, false],
    [{ ARMORIQ_USAGE_SYNC_DISABLED: "1" }, true, false],
    [{ ARMORIQ_OBSERVABILITY_DISABLED: "yes" }, false, false],
  ];
  for (const [env, observability, usageSync] of cases) {
    const cfg = loadConfigWithLogins([{ backend: STAGING, apiKey: KEY }], {
      ARMORIQ_ENV: "staging",
      ...env,
    });
    assert.equal(cfg.observabilityEnabled, observability, JSON.stringify(env));
    assert.equal(cfg.usageSyncEnabled, usageSync, JSON.stringify(env));
  }
});

test("the launcher starts no sync and writes no request while the usage sync is off", () => {
  for (const [name, toggles] of TOGGLES) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ac-sync-off-"));
    const cfg = loadConfigWithLogins([{ backend: STAGING, apiKey: KEY }], {
      ARMORIQ_ENV: "staging",
      CLAUDE_PLUGIN_DATA: dataDir,
      ...toggles,
    });
    assert.equal(requestUsageSync(cfg), false, name);
    assert.equal(launchUsageSync(cfg), false, name);
    assert.equal(existsSync(`${syncBasePath(dataDir)}.request`), false, name);
    assert.equal(existsSync(path.join(dataDir, "usage-sync.log")), false, name);
  }
});

function cliAgainst(home, port, env) {
  signedIn(home, port, KEY);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SYNC], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        ARMORIQ_DEVICE_ID_PATH: path.join(home, "device-id"),
        CLAUDE_PLUGIN_DATA: path.join(home, "data"),
        ARMORIQ_ENV: "local",
        ARMORIQ_BACKEND_URL: `http://127.0.0.1:${port}`,
        ...env,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

test("usage-sync posts nothing while observability or the usage sync is off", async () => {
  const { server, posts, port } = await fakeBackend();
  try {
    for (const [name, toggles] of TOGGLES) {
      const home = fixtureHome();
      const res = await cliAgainst(home, port, toggles);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stderr, /usage sync is off .*nothing synced/, name);
      assert.equal(existsSync(syncBasePath(path.join(home, "data"))), false, name);
    }
    assert.equal(posts.length, 0);

    const res = await cliAgainst(fixtureHome(), port, {
      CLAUDE_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "false",
      CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "false",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(posts.length, 3);
  } finally {
    server.close();
  }
});

test("usage-sync logs a backend 400 once with its session-hour, status and message, and exits 1", async () => {
  const body = { statusCode: 400, message: [HOUR_400, HOUR_400, HOUR_400], error: "Bad Request" };
  const { server, posts, port } = await fakeBackend(() => [400, body]);
  try {
    const home = fixtureHome();
    const res = await cliAgainst(home, port, {});
    assert.equal(posts.length, 3);
    assert.equal(res.status, 1, res.stderr);
    const failedLines = res.stderr.split("\n").filter((l) => l.includes("failed 3x"));
    assert.equal(failedLines.length, 1, res.stderr);
    assert.match(
      failedLines[0],
      new RegExp(
        `first at session ${S1} 2026-09-20 09:00 UTC: HTTP 400: usageHour must be an integer`
      )
    );
    assert.equal(res.stderr.includes(`${HOUR_400}; `), false, "the repeated message is dropped");
    assert.match(
      res.stderr,
      /posted 0 session-hour\(s\) \(0 tokens\), 3 failed \(3x HTTP 400: usageHour must/
    );
    assert.equal(res.stderr.includes(KEY), false);
    const lastRun = JSON.parse(
      readFileSync(userState(path.join(home, "data"), port, KEY), "utf8")
    ).lastRun;
    assert.equal(lastRun.failed, 3);
    assert.deepEqual(
      lastRun.failures.map((f) => [f.status, f.reason, f.count]),
      [[400, HOUR_400, 3]]
    );
  } finally {
    server.close();
  }
});

test("usage-sync against a closed port resolves no user, exits 1 fast and writes no state", async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const home = fixtureHome();
  const started = Date.now();
  const res = await cliAgainst(home, deadPort, {});
  const elapsed = Date.now() - started;
  assert.equal(res.status, 1, res.stderr);
  assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
  assert.match(res.stderr, /could not resolve the API key's user \(.+\), nothing synced/);
  assert.equal(existsSync(syncBasePath(path.join(home, "data"))), false);
});

test("a backend that drops token-usage requests stops the run after one row and keeps every row", async () => {
  let drop = true;
  const { server, posts, port } = await fakeBackend(() => (drop ? null : [200, { ok: true }]));
  try {
    const home = fixtureHome();
    const started = Date.now();
    const res = await cliAgainst(home, port, {});
    const elapsed = Date.now() - started;
    assert.equal(res.status, 1, res.stderr);
    assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
    const origin = `http://127.0.0.1:${port}`;
    const failedLines = res.stderr.split("\n").filter((l) => l.includes(" failed 1x"));
    assert.equal(failedLines.length, 1, res.stderr);
    assert.ok(failedLines[0].includes(`backend unreachable at ${origin}: `), res.stderr);
    assert.match(
      res.stderr,
      /posted 0 session-hour\(s\) \(0 tokens\), 1 failed \(1x backend unreachable at /
    );
    assert.match(res.stderr, /2 left for the next run/);
    const statePath = userState(path.join(home, "data"), port, KEY);
    assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).sessions, {});

    drop = false;
    const dropped = posts.length;
    const next = await cliAgainst(home, port, {});
    assert.equal(next.status, 0, next.stderr);
    assert.deepEqual(summary(posts.slice(dropped)), [
      [S1, "2026-09-20", 9, 133],
      [S1, "2026-09-21", 9, 1000],
      [S2, "2026-09-21", 10, 7],
    ]);
  } finally {
    server.close();
  }
});

async function withDaemon(daemonToggles, fn) {
  const home = fixtureHome();
  const dataDir = path.join(home, "data");
  const { server, posts, port } = await fakeBackend();
  const statePath = userState(dataDir, port, KEY);
  const lockPath = `${syncBasePath(dataDir)}.lock`;
  const env = pluginEnv(home, dataDir, port, KEY);
  mkdirSync(dataDir, { recursive: true });
  const daemon = spawn(process.execPath, [DAEMON], {
    stdio: "ignore",
    env: { ...env, ...daemonToggles },
    cwd: dataDir,
  });
  const stop = (toggles) =>
    dispatchViaDaemon({
      event: "Stop",
      input: {
        hook_event_name: "Stop",
        session_id: S2,
        transcript_path: path.join(projectsOf(home), "-work-repo-a", `${S2}.jsonl`),
      },
      config: withHome(home, () => loadConfig({ ...env, ...toggles })),
    });
  const synced = () =>
    until(() => readLastRun(statePath) !== undefined && !existsSync(lockPath), "a sync pass");
  try {
    await until(() => existsSync(path.join(dataDir, "daemon.sock")), "the daemon socket");
    await fn({ stop, synced, posts, statePath, dataDir });
  } finally {
    daemon.kill("SIGTERM");
    server.close();
  }
}

test("a Stop through the daemon starts no sync while the calling session turns it off", async () => {
  await withDaemon({}, async ({ stop, synced, posts, statePath, dataDir }) => {
    for (const [name, toggles] of TOGGLES) {
      await stop(toggles);
      assert.equal(existsSync(`${syncBasePath(dataDir)}.request`), false, name);
      assert.equal(existsSync(`${syncBasePath(dataDir)}.lock`), false, name);
    }
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(posts.length, 0);
    assert.equal(existsSync(statePath), false);

    await stop({});
    await synced();
    assert.equal(posts.length, 3);
  });
});

test("a daemon started while the usage sync was off syncs once the calling session turns it on", async () => {
  await withDaemon(SYNC_OFF, async ({ stop, synced, posts }) => {
    await stop({ CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "false" });
    await synced();
    assert.equal(posts.length, 3);
  });
});

function forkHome(withOriginal) {
  const home = mkdtempSync(path.join(tmpdir(), "ac-usage-fork-"));
  const original = [
    assistant("o1", "2026-09-20T09:00:00Z", 100),
    assistant("o2", "2026-09-20T09:05:00Z", 200),
  ];
  writeTree(path.join(projectsOf(home), "-work-repo-a"), {
    ...(withOriginal ? { [`${S1}.jsonl`]: original.map((l) => ({ ...l, sessionId: S1 })) } : {}),
    [`${S2}.jsonl`]: [
      { ...original[0], sessionId: S1, forkedFrom: { sessionId: S1 } },
      { ...original[1], sessionId: S1 },
      { ...assistant("f1", "2026-09-20T09:10:00Z", 7), sessionId: S2 },
    ],
  });
  return home;
}

test("a fork whose original transcript is gone posts only the lines it wrote", async () => {
  const home = forkHome(false);
  const { rows } = await run(home, await loadSyncState(path.join(home, "none.json")));
  assert.deepEqual(summary(rows), [[S2, "2026-09-20", 9, 7]]);
});

test("a fork's copied lines never stop its original from counting them", async () => {
  const home = forkHome(true);
  const state = await loadSyncState(path.join(home, "none.json"));
  assert.deepEqual(summary((await run(home, state)).rows), [
    [S1, "2026-09-20", 9, 300],
    [S2, "2026-09-20", 9, 7],
  ]);
  append(home, `${S1}.jsonl`, { ...assistant("o3", "2026-09-20T09:20:00Z", 1), sessionId: S1 });
  assert.deepEqual(summary((await run(home, state)).rows), [[S1, "2026-09-20", 9, 301]]);
});

function login(home, port, apiKey, at = new Date().toISOString()) {
  assert.ok(home.startsWith(tmpdir()), home);
  const backend = `http://127.0.0.1:${port}`;
  const file = path.join(home, ".armoriq", "credentials.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const doc = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { version: 2, active: null, profiles: {}, historyOrigin: "fresh", loginHistory: {} };
  const name = armoriqSdk.profileName(backend, "armorclaude");
  const history = doc.loginHistory[name] ?? { id: randomUUID(), origin: "fresh", events: [] };
  history.events.push({ sequence: history.events.length + 1, at, userId: userOf(apiKey) });
  doc.loginHistory[name] = history;
  doc.profiles[name] = {
    backend,
    product: "armorclaude",
    apiKey,
    email: "dev@example.com",
    userId: userOf(apiKey),
    orgId: "org-1",
    loggedInAt: at,
    savedAt: at,
  };
  doc.active = name;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

const signedIn = (home, port, apiKey) => {
  if (!existsSync(path.join(home, ".armoriq", "credentials.json"))) login(home, port, apiKey);
};

const asLoggedIn = { CLAUDE_PLUGIN_OPTION_API_KEY: "" };

function stateFiles(home) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".json"))
        files[path.relative(home, full)] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(path.join(home, "data"))) walk(path.join(home, "data"));
  return files;
}

const hourOf = (iso) => [iso.slice(0, 10), Number(iso.slice(11, 13))];
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();

test("a fresh install uploads every earlier session-hour", async () => {
  const { server, posts, port } = await fakeBackend();
  try {
    const home = fixtureHome();
    login(home, port, "ak_test_user_a");
    const a = await cliAgainst(home, port, asLoggedIn);
    assert.equal(a.status, 0, a.stderr);
    assert.deepEqual(summary(posts), [
      [S1, "2026-09-20", 9, 133],
      [S1, "2026-09-21", 9, 1000],
      [S2, "2026-09-21", 10, 7],
    ]);
  } finally {
    server.close();
  }
});

test("after a user switch, B uploads from its login on and A's state is untouched", async () => {
  const { server, posts, postedBy, port } = await fakeBackend();
  try {
    const home = fixtureHome();
    const rowsOf = (user) => posts.filter((_, i) => postedBy[i] === userOf(user));

    login(home, port, "ak_test_user_a");
    const a = await cliAgainst(home, port, asLoggedIn);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(rowsOf("ak_test_user_a").length, 3);
    const afterA = stateFiles(home);

    login(home, port, "ak_test_user_b");
    const b = await cliAgainst(home, port, asLoggedIn);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(rowsOf("ak_test_user_b").length, 0);
    assert.match(b.stderr, /uploading from \d{4}-\d{2}-\d{2}T\d{2}:00 UTC on/);
    const afterB = stateFiles(home);
    for (const [file, text] of Object.entries(afterA)) assert.equal(afterB[file], text, file);
    assert.equal(Object.keys(afterB).length, Object.keys(afterA).length + 1);

    const at = isoIn(60_000);
    append(home, `${S2}.jsonl`, assistant("b1", at, 11));
    const b2 = await cliAgainst(home, port, asLoggedIn);
    assert.equal(b2.status, 0, b2.stderr);
    assert.deepEqual(summary(rowsOf("ak_test_user_b")), [[S2, ...hourOf(at), 11]]);
  } finally {
    server.close();
  }
});

test("switching back, A skips only the hours another user had the device", async () => {
  const { server, posts, postedBy, port } = await fakeBackend();
  try {
    const home = fixtureHome();
    const dataDir = path.join(home, "data");
    const rowsOf = (user) => posts.filter((_, i) => postedBy[i] === userOf(user));
    login(home, port, "ak_test_user_a");
    assert.equal((await cliAgainst(home, port, asLoggedIn)).status, 0);
    const lastSyncA = new Date(Date.now() - 5 * 3_600_000);
    utimesSync(userState(dataDir, port, "ak_test_user_a"), lastSyncA, lastSyncA);
    login(home, port, "ak_test_user_b");
    assert.equal((await cliAgainst(home, port, asLoggedIn)).status, 0);

    const beforeSwitch = isoIn(-6 * 3_600_000);
    const whileB = isoIn(-3 * 3_600_000);
    const afterReturn = isoIn(60_000);
    append(home, `${S2}.jsonl`, assistant("a-late", beforeSwitch, 4));
    append(home, `${S2}.jsonl`, assistant("b-mid", whileB, 5));
    login(home, port, "ak_test_user_a");
    const back = await cliAgainst(home, port, asLoggedIn);
    assert.equal(back.status, 0, back.stderr);
    const hoursOfA = rowsOf("ak_test_user_a")
      .slice(3)
      .map((r) => [r.usageDate, r.usageHour]);
    assert.deepEqual(hoursOfA, [hourOf(beforeSwitch)]);
    assert.match(back.stderr, /since .* UTC, skipping the hours in between/);

    append(home, `${S2}.jsonl`, assistant("a-new", afterReturn, 6));
    const next = await cliAgainst(home, port, asLoggedIn);
    assert.equal(next.status, 0, next.stderr);
    const last = rowsOf("ak_test_user_a").at(-1);
    assert.deepEqual([last.usageDate, last.usageHour], hourOf(afterReturn));
  } finally {
    server.close();
  }
});

test("switching back, A still posts its own rows that failed before the switch", async () => {
  let down = true;
  const { server, posts, postedBy, port } = await fakeBackend(() =>
    down ? [503, {}] : [200, { ok: true }]
  );
  try {
    const home = fixtureHome();
    login(home, port, "ak_test_user_a");
    const failed = await cliAgainst(home, port, asLoggedIn);
    assert.equal(failed.status, 1, failed.stderr);
    down = false;
    login(home, port, "ak_test_user_b");
    assert.equal((await cliAgainst(home, port, asLoggedIn)).status, 0);

    const before = posts.length;
    login(home, port, "ak_test_user_a");
    const back = await cliAgainst(home, port, asLoggedIn);
    assert.equal(back.status, 0, back.stderr);
    const posted = posts
      .slice(before)
      .filter((_, i) => postedBy[before + i] === userOf("ak_test_user_a"));
    assert.deepEqual(summary(posted), [
      [S1, "2026-09-20", 9, 133],
      [S1, "2026-09-21", 9, 1000],
      [S2, "2026-09-21", 10, 7],
    ]);
  } finally {
    server.close();
  }
});

test("a key whose user the backend cannot resolve syncs nothing and writes no state", async () => {
  const { server, posts, port } = await fakeBackend();
  try {
    for (const [key, reason] of [
      ["ak_test_unknown_key", "validate-key returned 401"],
      ["ak_test_nouser_key", "validate-key returned no userId"],
    ]) {
      const home = fixtureHome();
      login(home, port, key);
      const res = await cliAgainst(home, port, asLoggedIn);
      assert.equal(res.status, 1, key);
      assert.ok(
        res.stderr.includes(`could not resolve the API key's user (${reason}), nothing synced`),
        res.stderr
      );
      assert.deepEqual(stateFiles(home), {}, key);
    }
    assert.equal(posts.length, 0);
  } finally {
    server.close();
  }
});

test("a sync running as one user leaves a pass requested with another user's key to that key", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { server, posts, postedBy, port } = await fakeBackend(async () => {
    if (posts.length === 1) await gate;
    return [200, { ok: true }];
  });
  try {
    const home = fixtureHome();
    const dataDir = path.join(home, "data");
    const postedAs = (key, sessionId) =>
      posts.some((row, i) => row.sessionId === sessionId && postedBy[i] === userOf(key));
    login(home, port, "ak_test_user_a");
    const a = cliAgainst(home, port, asLoggedIn);
    await until(() => posts.length === 1, "user A's first post");

    writeTree(path.join(projectsOf(home), "-work-repo-a"), {
      [`${S4}.jsonl`]: [assistant("n1", isoIn(60_000), 42)],
    });
    login(home, port, "ak_test_user_b");
    const asB = withHome(home, () => loadConfig(pluginEnv(home, dataDir, port)));
    assert.equal(requestUsageSync(asB), true);
    release();

    const aRes = await a;
    assert.equal(aRes.status, 0, aRes.stderr);
    assert.equal(postedAs("ak_test_user_a", S4), false);
    assert.match(aRes.stderr, /a pass was requested for another API key/);

    const b = await cliAgainst(home, port, asLoggedIn);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(postedAs("ak_test_user_b", S4), true);
  } finally {
    release();
    server.close();
  }
});

test("a backend URL with a trailing slash keys the same state", () => {
  const who = { product: "armorclaude", userId: "user-1" };
  assert.equal(
    userStatePath("/data", { ...who, backend: "http://127.0.0.1:9/" }),
    userStatePath("/data", { ...who, backend: "http://127.0.0.1:9" })
  );
});

async function switchedToB(backend) {
  const home = fixtureHome();
  login(home, backend.port, "ak_test_user_a");
  assert.equal((await cliAgainst(home, backend.port, asLoggedIn)).status, 0);
  login(home, backend.port, "ak_test_user_b");
  const b = await cliAgainst(home, backend.port, asLoggedIn);
  assert.equal(b.status, 0, b.stderr);
  return home;
}

test("a dashboard history request uploads the device's earlier history once, under that user", async () => {
  const backend = await fakeBackend();
  try {
    const rowsOf = (user) => backend.posts.filter((_, i) => backend.postedBy[i] === userOf(user));
    const home = await switchedToB(backend);
    assert.equal(rowsOf("ak_test_user_b").length, 0);

    const requestedAt = "2026-10-09T08:00:00.000Z";
    backend.history.requests.set(userOf("ak_test_user_b"), requestedAt);
    const full = await cliAgainst(home, backend.port, asLoggedIn);
    assert.equal(full.status, 0, full.stderr);
    assert.deepEqual(summary(rowsOf("ak_test_user_b")), summary(rowsOf("ak_test_user_a")));
    assert.deepEqual(
      backend.history.done.map(({ user, requestedAt: at, deviceId }) => [
        user,
        at,
        typeof deviceId,
      ]),
      [[userOf("ak_test_user_b"), requestedAt, "string"]]
    );

    const after = await cliAgainst(home, backend.port, asLoggedIn);
    assert.equal(after.status, 0, after.stderr);
    assert.equal(rowsOf("ak_test_user_b").length, 3);
    assert.equal(backend.history.done.length, 1);
  } finally {
    backend.server.close();
  }
});

test("if confirming the history request fails, the next run confirms without uploading again", async () => {
  const backend = await fakeBackend();
  try {
    const rowsOf = (user) => backend.posts.filter((_, i) => backend.postedBy[i] === userOf(user));
    const home = await switchedToB(backend);
    backend.history.requests.set(userOf("ak_test_user_b"), "2026-10-09T08:00:00.000Z");
    backend.history.failDone = true;
    const first = await cliAgainst(home, backend.port, asLoggedIn);
    assert.equal(rowsOf("ak_test_user_b").length, 3);
    assert.match(first.stderr, /could not confirm the dashboard's history request/);

    backend.history.failDone = false;
    const second = await cliAgainst(home, backend.port, asLoggedIn);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(rowsOf("ak_test_user_b").length, 3);
    assert.deepEqual(
      backend.history.done.map((d) => d.failed),
      [true, false]
    );
  } finally {
    backend.server.close();
  }
});

test("a history request that can't be read leaves the normal sync running", async () => {
  const backend = await fakeBackend();
  try {
    backend.history.failRead = true;
    const home = await switchedToB(backend);
    const rowsOf = (user) => backend.posts.filter((_, i) => backend.postedBy[i] === userOf(user));
    assert.equal(rowsOf("ak_test_user_a").length, 3);
    assert.equal(rowsOf("ak_test_user_b").length, 0);
    const again = await cliAgainst(home, backend.port, asLoggedIn);
    assert.equal(again.status, 0, again.stderr);
    assert.match(
      again.stderr,
      /could not read the dashboard's history request \(device-history-sync returned 500\), syncing as usual/
    );
  } finally {
    backend.server.close();
  }
});
