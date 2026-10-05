import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import armoriqSdk from "@armoriq/sdk-dev";
import {
  SPOOL_MAX_AGE_MS,
  SPOOL_MAX_BYTES,
  pruneSpool,
  shipRetryDelayMs,
  shipSpool,
  spoolDir,
  writeSpoolBatch,
} from "../scripts/lib/obs-spool.mjs";
import {
  __resetObsForTests,
  __setOtelTestHooksForTests,
  obsFlushAll,
  obsShipSpools,
} from "../scripts/lib/observability.mjs";
import { deadPid, placeFile } from "./helpers/obs-files.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;
const BINDING = "a".repeat(64);
const OTHER = "b".repeat(64);
const UUID = "00000000-0000-4000-8000-000000000000";
const API_KEY = "ak_test_spoolowner000000000000000000";

function tempDataDir() {
  return mkdtempSync(path.join(tmpdir(), "obs-spool-"));
}

const place = (dataDir, name, text) => placeFile(spoolDir(dataDir), name, text);

const entryName = (at, bytes, binding = BINDING, n = 0) =>
  `${at}-${bytes}-${binding}-${UUID.slice(0, -1)}${n}.json`;

const listed = (dataDir) => readdirSync(spoolDir(dataDir)).sort();

function fakeRuntime(statusOf) {
  const seen = [];
  return {
    seen,
    exportSpooled: async (batches) => {
      seen.push(...batches);
      return batches.map((batch) => ({ status: statusOf(batch) }));
    },
  };
}

test("a spooled batch is one whole owner-only file in an owner-only directory (#193)", async () => {
  const dataDir = tempDataDir();
  const batch = { version: 1, binding: BINDING, spans: [{ name: "armoriq.tool" }] };
  await writeSpoolBatch(dataDir, batch);
  const [name] = listed(dataDir);
  const text = readFileSync(path.join(spoolDir(dataDir), name), "utf8");
  assert.match(
    name,
    new RegExp(`^\\d+-${Buffer.byteLength(text)}-${BINDING}-[0-9a-f-]{36}\\.json$`)
  );
  assert.deepEqual(JSON.parse(text), batch);
  assert.equal(statSync(spoolDir(dataDir)).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(spoolDir(dataDir), name)).mode & 0o777, 0o600);
  await assert.rejects(writeSpoolBatch(dataDir, { ...batch, binding: "../x" }));
  assert.deepEqual(listed(dataDir), [name]);
});

test("the spool drops its oldest batches past 8 MiB, any past 7 days, and drafts past a minute (#193)", async () => {
  const dataDir = tempDataDir();
  const now = Date.now();
  const half = SPOOL_MAX_BYTES / 2;
  const oldest = place(dataDir, entryName(now - 3_000, half, BINDING, 1));
  const middle = place(dataDir, entryName(now - 2_000, half, OTHER, 2));
  const newest = place(dataDir, entryName(now - 1_000, half, BINDING, 3));
  const stale = place(dataDir, entryName(now - SPOOL_MAX_AGE_MS - 1, 10, BINDING, 4));
  const staleClaim = place(
    dataDir,
    `${entryName(now - SPOOL_MAX_AGE_MS - 1, 10, BINDING, 5)}.claim-1`
  );
  const oldDraft = place(dataDir, `${entryName(now - 61_000, 10, BINDING, 6)}.tmp.1.x`);
  const youngDraft = place(dataDir, `${entryName(now - 1_000, 10, BINDING, 7)}.tmp.1.y`);
  await pruneSpool(dataDir, now);
  const left = listed(dataDir);
  assert.deepEqual(left, [middle, newest, youngDraft].sort());
  for (const gone of [oldest, stale, staleClaim, oldDraft]) assert.ok(!left.includes(gone), gone);
});

test("shipping deletes acknowledged, discarded and rejected batches, keeps failed and newer-version ones (#193)", async () => {
  const dataDir = tempDataDir();
  const now = Date.now();
  const statuses = ["acknowledged", "discarded", "rejected", "failed", "unsupported"];
  const names = statuses.map((status, i) =>
    place(dataDir, entryName(now + i, 20, BINDING, i), JSON.stringify({ status }))
  );
  const garbled = place(dataDir, entryName(now + 5, 3, BINDING, 5), "{no");
  const runtime = fakeRuntime((batch) => (batch === null ? "rejected" : batch.status));
  const skip = new Set();
  const round = await shipSpool(dataDir, BINDING, runtime, { skip });
  assert.deepEqual(runtime.seen, [...statuses.map((status) => ({ status })), null]);
  assert.deepEqual(round, { shipped: 6, settled: 4, failed: true, more: false });
  assert.deepEqual(listed(dataDir), [names[3], names[4]]);
  assert.ok(!listed(dataDir).includes(garbled));
  runtime.seen.length = 0;
  await shipSpool(dataDir, BINDING, runtime, { skip });
  assert.deepEqual(runtime.seen, [{ status: "failed" }], "a newer-version batch is not sent again");
});

test("one round sends at most 64 batches, oldest first, and says more are due (#193)", async () => {
  const dataDir = tempDataDir();
  const now = Date.now();
  for (let i = 0; i < 70; i++) place(dataDir, entryName(now + i, 2, BINDING, i % 10), String(i));
  const runtime = fakeRuntime(() => "acknowledged");
  const first = await shipSpool(dataDir, BINDING, runtime);
  assert.deepEqual(runtime.seen, [...Array(64).keys()]);
  assert.equal(first.more, true);
  const second = await shipSpool(dataDir, BINDING, runtime);
  assert.deepEqual(runtime.seen.slice(64), [64, 65, 66, 67, 68, 69]);
  assert.deepEqual([second.more, listed(dataDir)], [false, []]);
});

test("a failing round retries after 5 s, doubling to at most 10 minutes (#193)", () => {
  const delays = [1, 2, 3, 4, 7, 8, 30].map(shipRetryDelayMs);
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 320_000, 600_000, 600_000]);
});

test("shipping takes over a dead process's claims, skips a live one's and another key's batches (#193)", async () => {
  const dataDir = tempDataDir();
  const now = Date.now();
  const orphan = place(dataDir, `${entryName(now, 2, BINDING, 1)}.claim-${deadPid()}`, '"orphan"');
  const busy = place(dataDir, `${entryName(now, 2, BINDING, 2)}.claim-${process.ppid}`, '"busy"');
  const foreign = place(dataDir, entryName(now, 2, OTHER, 3), '"foreign"');
  const runtime = fakeRuntime(() => "acknowledged");
  await shipSpool(dataDir, BINDING, runtime);
  assert.deepEqual(runtime.seen, ["orphan"]);
  assert.deepEqual(listed(dataDir), [busy, foreign].sort());
  assert.ok(!listed(dataDir).includes(orphan));
});

test("shipping an empty spool sends nothing (#193)", async () => {
  const runtime = fakeRuntime(() => "acknowledged");
  const round = await shipSpool(tempDataDir(), BINDING, runtime);
  assert.deepEqual(round, { shipped: 0, settled: 0, failed: false, more: false });
  assert.deepEqual(runtime.seen, []);
});

const lease = async () => ({
  captureMode: "metadata",
  revision: 1,
  expiresAt: new Date(Date.now() + 3_600_000),
  authoritative: true,
  contentCaptureAllowed: false,
  externalContentCaptureAllowed: false,
  externalContentAllowed: false,
  contentReasonCode: "test",
  debugExpiresAt: null,
});

async function startBackend(statusOf = () => 200) {
  const posts = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const traces = req.url === "/v1/traces";
      if (traces) posts.push(Date.now());
      res.writeHead(traces ? statusOf(posts.length) : 200, {
        "content-type": "application/x-protobuf",
      });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, posts, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function recordedBatches(backendEndpoint, apiKey) {
  const batches = [];
  const runtime = new ArmorIQTelemetryRuntime({
    backendEndpoint,
    apiKey,
    sdkVersion: "test",
    leaseFetcher: lease,
    spanSink: { write: async (batch) => void batches.push(batch) },
  });
  const session = new OtelSession(runtime, { sessionId: `sess-${apiKey.slice(-4)}` });
  await session.refreshPolicy();
  await session.beginRoot({ input: "spool" });
  await session.close({ status: "ok" });
  return batches;
}

test("a batch another key recorded is deleted unsent, its own key's batch ships (#193)", async () => {
  const backend = await startBackend();
  const runtime = new ArmorIQTelemetryRuntime({
    backendEndpoint: backend.url,
    apiKey: API_KEY,
    sdkVersion: "test",
    leaseFetcher: lease,
  });
  try {
    const dataDir = tempDataDir();
    const binding = runtime.spoolBinding;
    const [own] = await recordedBatches(backend.url, API_KEY);
    const [foreign] = await recordedBatches(backend.url, "ak_test_spoolother000000000000000000");
    place(dataDir, entryName(Date.now(), 10, binding, 1), JSON.stringify(foreign));
    await shipSpool(dataDir, binding, runtime);
    assert.deepEqual([backend.posts.length, listed(dataDir)], [0, []]);
    place(dataDir, entryName(Date.now(), 10, binding, 2), JSON.stringify(own));
    await shipSpool(dataDir, binding, runtime);
    assert.deepEqual([backend.posts.length, listed(dataDir)], [1, []]);
  } finally {
    await runtime.close();
    await backend.close();
  }
});

async function spooledCopies(backend, count) {
  const dataDir = tempDataDir();
  const [batch] = await recordedBatches(backend.url, API_KEY);
  for (let i = 0; i < count; i++) await writeSpoolBatch(dataDir, batch);
  return dataDir;
}

async function shipAsDaemon(backend, dataDir, until, what) {
  __resetObsForTests();
  __setOtelTestHooksForTests({ leaseFetcher: lease });
  obsShipSpools({
    observabilityEnabled: true,
    observabilityEndpoint: backend.url,
    apiKey: API_KEY,
    dataDir,
  });
  try {
    const deadline = Date.now() + 15_000;
    while (!until()) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await obsFlushAll();
    __setOtelTestHooksForTests(null);
    __resetObsForTests();
  }
}

const spoolLeft = (dataDir) => readdirSync(spoolDir(dataDir)).length;

test("the daemon drains more than 64 spooled batches in successive rounds (#193)", async () => {
  const backend = await startBackend();
  try {
    const dataDir = await spooledCopies(backend, 70);
    await shipAsDaemon(backend, dataDir, () => spoolLeft(dataDir) === 0, "an empty spool");
    assert.equal(backend.posts.length, 70);
  } finally {
    await backend.close();
  }
});

test("a round that acknowledged some batches goes on draining without a wait (#193)", async () => {
  const backend = await startBackend((n) => (n <= 2 ? 500 : 200));
  try {
    const dataDir = await spooledCopies(backend, 70);
    const started = Date.now();
    await shipAsDaemon(backend, dataDir, () => spoolLeft(dataDir) === 0, "an empty spool");
    assert.ok(Date.now() - started < 4_000, "no retry wait");
    assert.equal(backend.posts.length, 72);
  } finally {
    await backend.close();
  }
});

test("after a round that acknowledged nothing the daemon waits 5 s and then sends one batch (#193)", async () => {
  const backend = await startBackend(() => 500);
  try {
    const dataDir = await spooledCopies(backend, 3);
    const failedRound = () => backend.posts.length >= 3;
    let firstRoundAt;
    await shipAsDaemon(
      backend,
      dataDir,
      () => {
        if (failedRound()) firstRoundAt ??= Date.now();
        return firstRoundAt && Date.now() - firstRoundAt > 7_000;
      },
      "the retry"
    );
    const [, , third, probe, ...rest] = backend.posts;
    assert.ok(probe - third >= 4_500, `retried after ${probe - third} ms`);
    assert.deepEqual(rest, [], "the retry sent one batch");
    assert.equal(spoolLeft(dataDir), 3);
  } finally {
    await backend.close();
  }
});
