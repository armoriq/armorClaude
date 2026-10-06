import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { denyPreToolWithHint } from "../scripts/lib/hook-output.mjs";
import { OBS_RECORD_MAX_AGE_MS } from "../scripts/lib/obs-ages.mjs";
import { journalBacklog, journalEntryPath, journalEvent } from "../scripts/lib/obs-journal.mjs";
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
  const output = denyPreToolWithHint("Tool not in plan", {
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
    output: { hookSpecificOutput: { permissionDecision: "deny" } },
  });
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

  const backlog = await journalBacklog(dataDir, BINDING, busyFiles, now);

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
