import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTranscripts } from "../scripts/lib/transcripts.mjs";
import { loadSyncState, syncUsage } from "../scripts/lib/usage-sync.mjs";

const SYNC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "usage-sync.mjs"
);
const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S2 = "aaaaaaaa-0000-4000-8000-000000000002";
const S3 = "aaaaaaaa-0000-4000-8000-000000000003";

const assistant = (id, timestamp, input) => ({
  type: "assistant",
  cwd: "/work/repo-a",
  timestamp,
  requestId: `req-${id}`,
  message: { id, model: "claude-opus", usage: { input_tokens: input, output_tokens: 0 } },
});

function writeTree(root, files) {
  for (const [rel, lines] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, lines.map((l) => JSON.stringify(l)).join("\n"));
  }
}

function fixtureHome() {
  const home = mkdtempSync(path.join(tmpdir(), "ac-backfill-"));
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

const summary = (rows) =>
  rows.map((r) => [r.sessionId, r.usageDate, r.entries[0].inputTokens]).sort();

function append(home, rel, line) {
  appendFileSync(path.join(projectsOf(home), "-work-repo-a", rel), "\n" + JSON.stringify(line));
}

test("first run posts every session-day once, subagents folded into their session", async () => {
  const home = fixtureHome();
  const { rows, report } = await run(home, await loadSyncState(path.join(home, "none.json")));
  assert.deepEqual(summary(rows), [
    [S1, "2026-09-20", 133],
    [S1, "2026-09-21", 1000],
    [S2, "2026-09-21", 7],
  ]);
  assert.equal(report.changed, 2);
  assert.equal(report.read, 2);
  assert.equal(report.sessionDays, 3);
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

test("an appended transcript re-posts only its changed days and still skips forked history", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  await run(home, state);
  append(home, `${S2}.jsonl`, assistant("m4", "2026-09-22T08:00:00Z", 40));
  const first = await run(home, state);
  assert.deepEqual(summary(first.rows), [[S2, "2026-09-22", 40]]);
  assert.equal(first.report.read, 1);

  append(home, `${S1}/subagents/agent-a1.jsonl`, assistant("s2", "2026-09-21T11:00:00Z", 9));
  const second = await run(home, state);
  assert.deepEqual(summary(second.rows), [[S1, "2026-09-21", 1009]]);
});

test("files under subagents/ are never posted as sessions", async () => {
  const home = fixtureHome();
  const { rows } = await run(home, await loadSyncState(path.join(home, "none.json")));
  assert.deepEqual([...new Set(rows.map((r) => r.sessionId))].sort(), [S1, S2]);
});

test("a failed day is retried on the next run", async () => {
  const home = fixtureHome();
  const state = await loadSyncState(path.join(home, "none.json"));
  const failed = await run(home, state, { fail: (row) => row.sessionId === S2 });
  assert.equal(failed.report.failed, 1);
  const retry = await run(home, state);
  assert.deepEqual(summary(retry.rows), [[S2, "2026-09-21", 7]]);
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
    [S1, "2026-09-20", 133],
    [S1, "2026-09-21", 1000],
    [S2, "2026-09-21", 7],
  ]);
  for (const row of rows) assert.equal(row.product, "armorclaude");
  assert.match(first.stderr, /2 session\(s\) under .*\(3 subagent, 1 journal, 1 other file\(s\)\)/);
  assert.match(first.stderr, /2 changed, 2 read; would post 3 session-day\(s\) \(1140 tokens\)/);
  assert.match(first.stderr, /not read .*notes\.jsonl/);

  const second = cli(home, ["--dry-run"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "");
  assert.match(second.stderr, /0 changed, 0 read; would post 0 session-day\(s\) \(0 tokens\)/);
});

test("usage-sync without an API key posts nothing", () => {
  const home = fixtureHome();
  const res = cli(home, []);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /no API key, nothing synced/);
});
