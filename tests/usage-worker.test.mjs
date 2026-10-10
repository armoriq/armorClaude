import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assistant,
  backend,
  env,
  home,
  projectFile,
  run,
  sessionBatches,
  settled,
  stop,
  total,
  until,
  usageLine,
  writeSession,
} from "./helpers/live-usage.mjs";

const worker = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "usage-worker.mjs"
);
const HOUR = 3_600_000;
const hourStart = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR;
const at = (minute) => new Date(hourStart + minute * 60_000).toISOString();

async function withBackend(loggedInAt, fn) {
  const b = await backend();
  b.release();
  const h = home(b.url, loggedInAt);
  try {
    await fn(b, h);
  } finally {
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
}

const runWorker = async (h, b) => {
  const result = await run(worker, env(h, b.url, false));
  assert.equal(result.code, 0, result.stderr);
  return result;
};
const failSecondBatch = (b) => {
  let seen = 0;
  b.onBatch = (res) => {
    if (++seen !== 2) return false;
    b.onBatch = null;
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "busy" }));
    return true;
  };
};
const reportsOf = (b, mode) => b.reports.filter((r) => r.mode === mode);

test("a session admits its usage from before the login only after a history upload of it is acknowledged (10 + 20 + 5 = 35)", async () => {
  await withBackend(at(30), async (b, h) => {
    const id = randomUUID();
    writeSession(h, id, [
      assistant(id, "pre", at(10), { input_tokens: 10 }),
      assistant(id, "post", at(40), { input_tokens: 20 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length === 1, "the live batch");
    await settled(h, id);
    assert.deepEqual(sessionBatches(b, id).map(total), [20]);

    b.requestId = randomUUID();
    let refused = 0;
    b.onBatch = (res, body) => {
      if (!body.runId) return false;
      refused += 1;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "busy" }));
      return true;
    };
    await runWorker(h, b);
    assert.equal(refused, 1);
    appendFileSync(projectFile(h, id), usageLine(id, "late", at(50), { input_tokens: 5 }));
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length === 3, "the live batch before the grant");
    await settled(h, id);
    assert.equal(total(sessionBatches(b, id).at(-1)), 25);

    b.onBatch = null;
    await runWorker(h, b);
    const history = b.batches.filter((x) => x.runId && b.runs.get(x.runId)?.mode === "history");
    assert.deepEqual(history.at(-1).snapshots.map(total), [30]);
    assert.equal(reportsOf(b, "history").at(-1).phase, "complete");
    assert.equal(b.requestId, null);

    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length === 5, "the live batch after the grant");
    await settled(h, id);
    assert.equal(total(sessionBatches(b, id).at(-1)), 35);
  });
});

test("a run keeps every acknowledged batch when a later one fails, and the next run sends only the rest", async () => {
  await withBackend(at(0), async (b, h) => {
    const ids = Array.from({ length: 101 }, () => randomUUID());
    for (const id of ids) writeSession(h, id, [assistant(id, "m", at(20), { input_tokens: 1 })]);
    failSecondBatch(b);
    await runWorker(h, b);
    assert.deepEqual(
      b.batches.map((x) => x.snapshots.length),
      [100, 1]
    );
    assert.deepEqual(
      reportsOf(b, "discovery").map((r) => [r.phase, r.errorCode]),
      [
        ["discovering", undefined],
        ["retrying", "upload_failed"],
      ]
    );
    await runWorker(h, b);
    assert.equal(b.batches.length, 3);
    assert.equal(b.batches[2].batchId, b.batches[1].batchId);
    const done = reportsOf(b, "discovery").at(-1);
    assert.deepEqual([done.phase, done.total], ["complete", 101]);

    await runWorker(h, b);
    assert.equal(b.batches.length, 3);
    assert.equal(b.reports.length, 3);
  });
});

test("a history request cancelled before its upload is acknowledged sends nothing more and admits nothing", async () => {
  await withBackend(at(30), async (b, h) => {
    const id = randomUUID();
    writeSession(h, id, [
      assistant(id, "pre", at(10), { input_tokens: 10 }),
      assistant(id, "post", at(40), { input_tokens: 20 }),
    ]);
    b.requestId = randomUUID();
    failSecondBatch(b);
    await runWorker(h, b);
    assert.deepEqual(
      b.batches.map((x) => [b.runs.get(x.runId).mode, x.snapshots.map(total)]),
      [
        ["discovery", [20]],
        ["history", [30]],
      ]
    );
    b.requestId = null;
    await runWorker(h, b);
    assert.equal(b.batches.length, 2);
    assert.equal(b.reports.at(-1).phase, "retrying");
    assert.equal(
      reportsOf(b, "history").some((r) => r.phase === "complete"),
      false
    );
    appendFileSync(projectFile(h, id), usageLine(id, "late", at(50), { input_tokens: 5 }));
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length === 3, "the live batch");
    await settled(h, id);
    assert.equal(total(sessionBatches(b, id).at(-1)), 25);
  });
});

test("a history request stays open while one of its sessions cannot be read, and completes once it is read", async () => {
  await withBackend(at(30), async (b, h) => {
    const id = randomUUID();
    writeSession(h, id, [assistant(id, "pre", at(10), { input_tokens: 10 })]);
    const sub = path.join(path.dirname(projectFile(h, id)), id, "subagents", "agent-a.jsonl");
    mkdirSync(path.dirname(sub), { recursive: true });
    writeFileSync(sub, usageLine(id, "sub", at(12), { input_tokens: 4 }), { mode: 0o000 });
    b.requestId = randomUUID();
    for (let pass = 0; pass < 2; pass++) {
      await runWorker(h, b);
      const last = reportsOf(b, "history").at(-1);
      assert.deepEqual([last.phase, last.errorCode], ["uploading", "source_unreadable"]);
      assert.notEqual(b.requestId, null);
    }
    chmodSync(sub, 0o600);
    await runWorker(h, b);
    assert.equal(reportsOf(b, "history").at(-1).phase, "complete");
    assert.equal(b.requestId, null);
    assert.equal(total(sessionBatches(b, id).at(-1)), 14);
  });
});
