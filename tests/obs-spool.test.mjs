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
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import armoriqSdk from "@armoriq/sdk-dev";
import { obsBindingKey } from "../scripts/lib/obs-lease-store.mjs";
import {
  SPOOL_MAX_AGE_MS,
  SPOOL_MAX_BYTES,
  pruneSpool,
  shipSpool,
  spoolDir,
  writeSpoolBatch,
} from "../scripts/lib/obs-spool.mjs";

const { ArmorIQTelemetryRuntime, OtelSession } = armoriqSdk;
const BINDING = "a".repeat(32);
const OTHER = "b".repeat(32);
const UUID = "00000000-0000-4000-8000-000000000000";

function tempDataDir() {
  return mkdtempSync(path.join(tmpdir(), "obs-spool-"));
}

function place(dataDir, name, text = "{}") {
  const dir = spoolDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  return name;
}

const entryName = (at, bytes, binding = BINDING, n = 0) =>
  `${at}-${bytes}-${binding}-${UUID.slice(0, -1)}${n}.json`;

const listed = (dataDir) => readdirSync(spoolDir(dataDir)).sort();

function deadPid() {
  return spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  }).stdout;
}

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
  const batch = { version: 1, binding: "x", spans: [{ name: "armoriq.tool" }] };
  await writeSpoolBatch(dataDir, BINDING, batch);
  const [name] = listed(dataDir);
  const text = readFileSync(path.join(spoolDir(dataDir), name), "utf8");
  assert.match(
    name,
    new RegExp(`^\\d+-${Buffer.byteLength(text)}-${BINDING}-[0-9a-f-]{36}\\.json$`)
  );
  assert.deepEqual(JSON.parse(text), batch);
  assert.equal(statSync(spoolDir(dataDir)).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(spoolDir(dataDir), name)).mode & 0o777, 0o600);
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

test("shipping deletes acknowledged and rejected batches and keeps failed ones for a retry (#193)", async () => {
  const dataDir = tempDataDir();
  const now = Date.now();
  const names = ["acknowledged", "rejected", "failed"].map((status, i) =>
    place(dataDir, entryName(now + i, 20, BINDING, i), JSON.stringify({ status }))
  );
  const garbled = place(dataDir, entryName(now + 3, 3, BINDING, 3), "{no");
  const runtime = fakeRuntime((batch) => (batch === null ? "rejected" : batch.status));
  const round = await shipSpool(dataDir, BINDING, runtime);
  assert.deepEqual(runtime.seen, [
    { status: "acknowledged" },
    { status: "rejected" },
    { status: "failed" },
    null,
  ]);
  assert.deepEqual(round, { shipped: 4, failed: true, more: false });
  assert.deepEqual(listed(dataDir), [names[2]]);
  assert.ok(!listed(dataDir).includes(garbled));
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
  assert.deepEqual(round, { shipped: 0, failed: false, more: false });
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

async function startBackend() {
  const posts = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/traces") posts.push(req.url);
      res.writeHead(200, { "content-type": "application/x-protobuf" });
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
    apiKey: "ak_test_spoolowner000000000000000000",
    sdkVersion: "test",
    leaseFetcher: lease,
  });
  try {
    const dataDir = tempDataDir();
    const binding = obsBindingKey(backend.url, "ak_test_spoolowner000000000000000000");
    const [own] = await recordedBatches(backend.url, "ak_test_spoolowner000000000000000000");
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
