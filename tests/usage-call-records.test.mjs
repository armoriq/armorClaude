import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assistant,
  env,
  home,
  backend,
  isoAgo,
  projectFile,
  run,
  sessionBatches,
  settled,
  stop,
  until,
  usageLine,
  withSession,
  writeSession,
} from "./helpers/live-usage.mjs";

const worker = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "usage-worker.mjs"
);

const callsOf = (b, id) =>
  b.uploads.flatMap((x) => (x.calls ?? []).filter((c) => c.sessionId === id));
const recordsOf = (b, id) => callsOf(b, id).flatMap((c) => c.records);
const keysOf = (b, id) => recordsOf(b, id).map((r) => r.key);

test("a Stop sends one call record per new assistant message, next to the hourly snapshots", async () => {
  await withSession(async (b, h, id) => {
    const at = isoAgo(60_000);
    writeSession(h, id, [
      assistant(id, "a", at, { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 }),
      assistant(id, "b", at, { input_tokens: 3, output_tokens: 1 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => recordsOf(b, id).length === 2, "two call records");
    await settled(h, id);
    const [a] = recordsOf(b, id);
    assert.deepEqual(a, {
      key: "a:r-a",
      model: "claude-opus",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      occurredAt: new Date(Date.parse(at)).toISOString(),
    });
    assert.equal(callsOf(b, id)[0].armored, true);
    assert.equal(sessionBatches(b, id).length, 1, "the hourly snapshot still goes out");

    appendFileSync(projectFile(h, id), usageLine(id, "c", isoAgo(30_000), { input_tokens: 4 }));
    await stop(h, b.url, false, id);
    await until(() => recordsOf(b, id).length === 3, "the new message's record");
    await settled(h, id);
    assert.deepEqual(keysOf(b, id), ["a:r-a", "b:r-b", "c:r-c"]);
  });
});

test("after the usage stream is reset every message is sent again under the new generation", async () => {
  await withSession(async (b, h, id) => {
    writeSession(h, id, [assistant(id, "a", isoAgo(60_000), { input_tokens: 4 })]);
    await stop(h, b.url, false, id);
    await until(() => recordsOf(b, id).length === 1, "the first record");
    await settled(h, id);
    b.generation = randomUUID();
    appendFileSync(projectFile(h, id), usageLine(id, "b", isoAgo(30_000), { input_tokens: 5 }));
    await stop(h, b.url, false, id);
    await until(() => recordsOf(b, id).length === 3, "both records again");
    await settled(h, id);
    const latest = b.uploads.filter((x) => x.generation === b.generation);
    const keys = latest.flatMap((x) => (x.calls ?? []).flatMap((c) => c.records.map((r) => r.key)));
    assert.deepEqual(keys.sort(), ["a:r-a", "b:r-b"]);
  });
});

test("messages from before the login and lines copied from a parent session are not sent", async () => {
  const b = await backend();
  b.release();
  const h = home(b.url, isoAgo(30 * 60_000));
  try {
    const id = randomUUID();
    writeSession(h, id, [
      assistant("parent-session", "copied", isoAgo(10 * 60_000), { input_tokens: 9 }),
      assistant(id, "before", isoAgo(40 * 60_000), { input_tokens: 7 }),
      assistant(id, "after", isoAgo(10 * 60_000), { input_tokens: 8 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => recordsOf(b, id).length > 0, "the record");
    await settled(h, id);
    assert.deepEqual(keysOf(b, id), ["after:r-after"]);
  } finally {
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
  }
});

test("a session with more messages than one batch takes is split across batches, each message once", async () => {
  await withSession(async (b, h, id) => {
    const at = isoAgo(60_000);
    writeSession(
      h,
      id,
      Array.from({ length: 1203 }, (_, i) => assistant(id, `m${i}`, at, { input_tokens: 1 }))
    );
    await stop(h, b.url, false, id);
    await until(() => recordsOf(b, id).length === 1203, "every record", 40_000);
    await settled(h, id);
    for (const x of b.uploads) {
      const count = (x.calls ?? []).reduce((n, c) => n + c.records.length, 0);
      assert.ok(count <= 500, `a batch holds ${count} records`);
    }
    assert.equal(new Set(keysOf(b, id)).size, 1203);
  });
});

test("the usage worker sends the call records of the sessions it scans, under its run", async () => {
  await withSession(async (b, h, id) => {
    writeSession(h, id, [assistant(id, "a", isoAgo(60_000), { input_tokens: 3 })]);
    const { code } = await run(worker, env(h, b.url, false));
    assert.equal(code, 0);
    assert.deepEqual(keysOf(b, id), ["a:r-a"]);
    const callBatches = b.uploads.filter((x) => x.calls);
    assert.ok(
      callBatches.every((x) => b.runs.has(x.runId)),
      "each call batch names an open run"
    );
  });
});
