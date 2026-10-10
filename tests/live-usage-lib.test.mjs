import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { liveTranscript, loginCutoff, packBatches } from "../scripts/lib/live-usage.mjs";

test("the live upload takes only a transcript of the stopping session inside the projects directory", () => {
  const projects = "/home/u/.claude/projects";
  const id = randomUUID();
  assert.equal(
    liveTranscript(projects, id, `${projects}/-work/${id}.jsonl`),
    `${projects}/-work/${id}.jsonl`
  );
  for (const bad of [
    `/tmp/${id}.jsonl`,
    `${projects}/../${id}.jsonl`,
    `${projects}/-work/other.jsonl`,
    `relative/${id}.jsonl`,
    7,
  ]) {
    assert.equal(liveTranscript(projects, id, bad), null);
  }
  assert.equal(
    liveTranscript(projects, "not-a-session", `${projects}/-work/not-a-session.jsonl`),
    null
  );
});

test("the login cutoff exists only for a login history whose last login is the saved login", () => {
  const at = "2026-10-10T09:00:00.000Z";
  const history = { id: "h", origin: "fresh", events: [{ sequence: 1, at, userId: "u" }] };
  assert.equal(loginCutoff({ loginHistory: history, userId: "u", loggedInAt: at }), Date.parse(at));
  assert.equal(loginCutoff({ loginHistory: history, userId: "v", loggedInAt: at }), null);
  assert.equal(
    loginCutoff({ loginHistory: history, userId: "u", loggedInAt: "2026-10-10T08:00:00.000Z" }),
    null
  );
  assert.equal(loginCutoff({ loginHistory: null, userId: "u", loggedInAt: at }), null);
});

test("batches stay within the backend's snapshot, entry and byte limits", () => {
  const snapshot = (i, entries, model = "m") => ({
    sessionId: `s-${i}`,
    usageDate: "2026-10-10",
    usageHour: 1,
    revision: 1,
    entries: Array.from({ length: entries }, (_, j) => ({
      model: `${model}${j}`,
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })),
  });
  assert.deepEqual(
    packBatches(Array.from({ length: 250 }, (_, i) => snapshot(i, 1))).map((b) => b.length),
    [100, 100, 50]
  );
  assert.deepEqual(
    packBatches(Array.from({ length: 120 }, (_, i) => snapshot(i, 6))).map((b) => b.length),
    [83, 37]
  );
  const wide = packBatches(Array.from({ length: 100 }, (_, i) => snapshot(i, 5, "x".repeat(600))));
  assert.ok(wide.length > 1);
  for (const batch of wide) assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 256 * 1024);
});
