import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DECISION_CODE, denyPreToolWithHint } from "../scripts/lib/hook-output.mjs";
import { OBS_RECORD_MAX_AGE_MS } from "../scripts/lib/obs-ages.mjs";
import {
  JOURNAL_MAX_ENTRIES,
  journalBacklog,
  journalEntryPath,
  journalEvent,
  settledEvents,
} from "../scripts/lib/obs-journal.mjs";
import { deadPid, placeFile } from "./helpers/obs-files.mjs";

const BINDING = "a".repeat(64);
const OTHER = "b".repeat(64);
const UUID = "00000000-0000-4000-8000-00000000000";

const tempDataDir = () => mkdtempSync(path.join(tmpdir(), "obs-journal-"));
const journalDir = (dataDir) => path.join(dataDir, "obs-journal");

function place(dataDir, { at, seq = 0, owner, binding = BINDING, n, draft = "" }) {
  const name = `${at}-${seq}-${binding}-${UUID}${n}.json.claim-${owner}${draft}`;
  return placeFile(journalDir(dataDir), name, JSON.stringify({ event: `e${n}`, input: {} }));
}

test("a journaled event is an owner-only file with the call's identity and decision, no tool input (#194)", async () => {
  const dataDir = tempDataDir();
  const input = {
    session_id: "sess-j",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_01J",
    tool_input: { command: "curl -H 'Authorization: Bearer SECRET_TOKEN_123' https://x" },
  };
  const output = denyPreToolWithHint("intent_drift", "Tool not in plan", {
    toolName: "Bash",
    toolInput: input.tool_input,
    goal: "g",
  });
  const at = Date.now();
  const file = await journalEvent(journalEntryPath(dataDir, BINDING, at), {
    event: "PreToolUse",
    input,
    output,
    at,
  });
  assert.match(
    path.basename(file),
    new RegExp(`^${at}-\\d+-${BINDING}-.+\\.claim-${process.pid}$`)
  );
  assert.equal(statSync(journalDir(dataDir)).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.ok(!text.includes("SECRET_TOKEN_123"));
  assert.deepEqual(JSON.parse(text), {
    event: "PreToolUse",
    at,
    input: {
      session_id: "sess-j",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_01J",
    },
    output: { hookSpecificOutput: { permissionDecision: "deny" }, decisionCode: "intent_drift" },
  });
});

test("a replayed deny keeps the code of the rule that decided it (#194, #201)", async () => {
  const dataDir = tempDataDir();
  const at = Date.now() - 1_000;
  const output = {
    hookSpecificOutput: { permissionDecision: "deny" },
    decisionCode: "policy_denied",
  };
  const record = { event: "PreToolUse", at, input: { session_id: "s" }, output };
  placeFile(
    journalDir(dataDir),
    `${at}-0-${BINDING}-${UUID}1.json.claim-${deadPid()}`,
    JSON.stringify(record)
  );
  const {
    backlog: [replayed],
  } = await journalBacklog(dataDir, BINDING, new Set(), Date.now());
  assert.equal(replayed.record.output[DECISION_CODE], "policy_denied");
});

test("the backlog of one key adopts dead processes' events in order and prunes old entries and drafts (#194)", async () => {
  const dataDir = tempDataDir();
  const dead = deadPid();
  const now = Date.now();
  place(dataDir, { at: now - 10, seq: 1, owner: dead, n: 2 });
  place(dataDir, { at: now - 10, seq: 0, owner: dead, n: 1 });
  place(dataDir, { at: now - 20, seq: 5, owner: dead, n: 0 });
  place(dataDir, { at: now - 5, owner: process.pid, n: 3 });
  const busy = place(dataDir, { at: now - 4, owner: process.pid, n: 4 });
  const live = place(dataDir, { at: now - 30, owner: process.ppid, n: 5 });
  const otherKey = place(dataDir, { at: now - 30, owner: dead, binding: OTHER, n: 6 });
  const stale = place(dataDir, { at: now - OBS_RECORD_MAX_AGE_MS - 1, owner: dead, n: 7 });
  const oldDraft = place(dataDir, { at: now - 61_000, owner: dead, n: 8, draft: ".tmp.1.x" });
  const youngDraft = place(dataDir, { at: now - 1_000, owner: dead, n: 9, draft: ".tmp.1.y" });
  const busyFiles = new Set([path.join(journalDir(dataDir), busy)]);

  const { backlog, dropped } = await journalBacklog(dataDir, BINDING, busyFiles, now);
  assert.equal(dropped, 0);

  assert.deepEqual(
    backlog.map((b) => b.record.event),
    ["e0", "e1", "e2", "e3"]
  );
  for (const { file } of backlog) assert.ok(file.endsWith(`.claim-${process.pid}`), file);
  const left = readdirSync(journalDir(dataDir));
  for (const kept of [busy, live, otherKey, youngDraft]) assert.ok(left.includes(kept), kept);
  for (const gone of [stale, oldDraft]) assert.ok(!left.includes(gone), gone);
  assert.equal(left.length, 8);
});

test("an event whose span landed in a written batch is settled although a later write failed (#194)", () => {
  const pending = [
    { file: "landed", failures: 0, call: "policy:toolu_01A" },
    { file: "lost", failures: 0, call: "tool:toolu_01A" },
    { file: "no-call", failures: 0, call: null },
    { file: "after-failure", failures: 1, call: null },
  ];
  const written = new Set(["policy:toolu_01A"]);
  const settled = settledEvents(pending, { sinkFailures: 1, written });
  assert.deepEqual(
    settled.map((item) => item.file),
    ["landed", "after-failure"]
  );
});

test("the journal keeps its newest entries up to the limit and never drops one a live process holds (#200)", async () => {
  const dataDir = tempDataDir();
  const dir = journalDir(dataDir);
  const now = Date.now();
  const dead = deadPid();
  const entry = (at, owner) =>
    placeFile(dir, `${at}-0-${OTHER}-${randomUUID()}.json.claim-${owner}`, "{}");
  const inFlight = entry(now - 50_000, process.pid);
  const anotherProcess = entry(now - 49_000, process.ppid);
  const names = [];
  for (let i = 0; i < JOURNAL_MAX_ENTRIES + 4; i++) names.push(entry(now - 40_000 + i, dead));

  const { dropped } = await journalBacklog(
    dataDir,
    BINDING,
    new Set([path.join(dir, inFlight)]),
    now
  );

  const left = new Set(readdirSync(dir));
  assert.equal(dropped, 4);
  assert.ok(left.has(inFlight));
  assert.ok(left.has(anotherProcess), "an entry a live process holds is never dropped");
  assert.deepEqual(
    names.slice(0, 4).filter((name) => left.has(name)),
    []
  );
  assert.equal(left.size, JOURNAL_MAX_ENTRIES + 2);
});

test("files from an older journal name format are deleted once they are a minute old (#194)", async () => {
  const dataDir = tempDataDir();
  const dir = journalDir(dataDir);
  const now = Date.now();
  const old = placeFile(dir, `${now - 120_000}-0-${deadPid()}-${BINDING}-${UUID}1.json`, "{}");
  const young = placeFile(dir, `${now}-0-${deadPid()}-${BINDING}-${UUID}2.json`, "{}");
  const writtenAt = new Date(now - 120_000);
  utimesSync(path.join(dir, old), writtenAt, writtenAt);

  await journalBacklog(dataDir, BINDING, new Set(), now);

  assert.deepEqual(readdirSync(dir), [young]);
});
