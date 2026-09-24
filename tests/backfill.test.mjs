import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTranscripts } from "../scripts/lib/transcripts.mjs";

const BACKFILL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "backfill.mjs"
);
const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S2 = "aaaaaaaa-0000-4000-8000-000000000002";

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
    `-work-repo-a/${S1}/subagents/agent-a1.jsonl`,
    `-work-repo-a/${S1}/subagents/workflows/wf_1/agent-b1.jsonl`,
  ]);
  assert.deepEqual(rel(groups.journal), [
    `-work-repo-a/${S1}/subagents/workflows/wf_1/journal.jsonl`,
  ]);
  assert.deepEqual(rel(groups.other), ["-work-repo-a/notes.jsonl"]);
});

test("backfill --dry-run posts one row per session-day and counts forked history once", () => {
  const home = fixtureHome();
  const run = spawnSync(process.execPath, [BACKFILL, "--dry-run"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ARMORIQ_API_KEY: "ak_test_backfill",
      ARMORIQ_DEVICE_ID_PATH: path.join(home, "device-id"),
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const rows = run.stdout
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.sessionId, r.usageDate, r.entries[0].inputTokens]).sort(), [
    [S1, "2026-09-20", 130],
    [S1, "2026-09-21", 1000],
    [S2, "2026-09-21", 7],
  ]);
  assert.match(run.stderr, /2 main, 2 subagent, 1 workflow journal, 1 other transcript\(s\)/);
  assert.match(run.stderr, /not read .*notes\.jsonl/);
  assert.match(run.stderr, /done: would post 3 session-day\(s\) \(1137 tokens\)/);
  assert.doesNotMatch(run.stderr, /posted/);
});
