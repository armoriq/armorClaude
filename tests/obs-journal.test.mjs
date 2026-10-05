import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  JOURNAL_MAX_AGE_MS,
  adoptOrphanedEvents,
  journalDir,
  journalEvent,
} from "../scripts/lib/obs-journal.mjs";

const UUID = "00000000-0000-4000-8000-00000000000";

function deadPid() {
  return spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  }).stdout;
}

function place(dataDir, at, seq, owner, n) {
  const dir = journalDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${at}-${seq}-${owner}-${UUID}${n}.json`;
  writeFileSync(path.join(dir, name), JSON.stringify({ event: `e${n}`, input: {} }));
  return name;
}

test("a journaled event is an owner-only file holding the call's identity and decision, no content (#194)", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "obs-journal-"));
  const input = {
    session_id: "sess-j",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "toolu_01J",
    tool_input: { command: "cat secrets.txt" },
    tool_response: { stdout: "hunter2" },
  };
  const output = { hookSpecificOutput: { permissionDecision: "allow", additionalContext: "x" } };
  const file = await journalEvent(dataDir, "PostToolUse", input, output);
  assert.equal(statSync(journalDir(dataDir)).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
    event: "PostToolUse",
    input: {
      session_id: "sess-j",
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "toolu_01J",
    },
    output: { hookSpecificOutput: { permissionDecision: "allow" } },
  });
});

test("a starting daemon adopts a dead process's events in order and leaves a live one's (#194)", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "obs-journal-"));
  const dead = deadPid();
  const now = Date.now();
  place(dataDir, now - 10, 1, dead, 2);
  place(dataDir, now - 10, 0, dead, 1);
  place(dataDir, now - 20, 5, dead, 0);
  const live = place(dataDir, now - 30, 0, process.ppid, 3);
  const stale = place(dataDir, now - JOURNAL_MAX_AGE_MS - 1, 0, dead, 4);
  const adopted = await adoptOrphanedEvents(dataDir, now);
  assert.deepEqual(
    adopted.map((a) => a.record.event),
    ["e0", "e1", "e2"]
  );
  for (const { file } of adopted) assert.match(path.basename(file), new RegExp(`-${process.pid}-`));
  const left = readdirSync(journalDir(dataDir));
  assert.ok(left.includes(live));
  assert.ok(!left.includes(stale));
  assert.equal(left.length, 4);
});
