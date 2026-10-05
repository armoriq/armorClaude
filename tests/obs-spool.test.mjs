import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OBS_RECORD_MAX_AGE_MS } from "../scripts/lib/obs-ages.mjs";
import {
  SPOOL_MAX_TRIES,
  shipRetryDelayMs,
  shipSpool,
  writeSpoolBatch,
} from "../scripts/lib/obs-spool.mjs";
import { deadPid, placeFile } from "./helpers/obs-files.mjs";

const BINDING = "a".repeat(64);
const OTHER = "b".repeat(64);
const UUID = "00000000-0000-4000-8000-000000000000";
const SPOOL_MAX_BYTES = 8 * 1024 * 1024;

function tempDataDir() {
  return mkdtempSync(path.join(tmpdir(), "obs-spool-"));
}

const spoolDir = (dataDir) => path.join(dataDir, "obs-spool");

const place = (dataDir, name, text) => placeFile(spoolDir(dataDir), name, text);

const entryName = (at, bytes, binding = BINDING, n = 0, tries = 0, dueAt = 0) =>
  `${at}-${bytes}-${binding}-${UUID.slice(0, -1)}${n}-${tries}-${dueAt}.json`;

const listed = (dataDir) => readdirSync(spoolDir(dataDir)).sort();

function fakeRuntime(statusOf) {
  const seen = [];
  return {
    seen,
    exportSpooled: async (batches) => {
      seen.push(...batches);
      return batches.map((batch) => {
        const [status, reason] = statusOf(batch).split("/");
        return { status, reason };
      });
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
    new RegExp(`^\\d+-${Buffer.byteLength(text)}-${BINDING}-[0-9a-f-]{36}-0-0\\.json$`)
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
  const half = SPOOL_MAX_BYTES / 2 - 1_024;
  const oldest = place(dataDir, entryName(now - 3_000, half, BINDING, 1));
  const middle = place(dataDir, entryName(now - 2_000, half, OTHER, 2));
  const newest = place(dataDir, entryName(now - 1_000, half, BINDING, 3));
  const stale = place(dataDir, entryName(now - OBS_RECORD_MAX_AGE_MS - 1, 10, BINDING, 4));
  const staleClaim = place(
    dataDir,
    `${entryName(now - OBS_RECORD_MAX_AGE_MS - 1, 10, BINDING, 5)}.claim-1`
  );
  const oldDraft = place(dataDir, `${entryName(now - 61_000, 10, BINDING, 6)}.tmp.1.x`);
  const youngDraft = place(dataDir, `${entryName(now - 1_000, 10, BINDING, 7)}.tmp.1.y`);
  await writeSpoolBatch(dataDir, { version: 1, binding: BINDING, spans: [] });
  const left = listed(dataDir);
  const written = left.find((name) => ![middle, newest, youngDraft].includes(name));
  assert.deepEqual(left, [middle, newest, youngDraft, written].sort());
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
  assert.deepEqual(round, {
    shipped: 6,
    settled: 4,
    dropped: 0,
    outage: true,
    more: false,
    nextDueAt: Infinity,
  });
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
  assert.deepEqual(round, {
    shipped: 0,
    settled: 0,
    dropped: 0,
    outage: false,
    more: false,
    nextDueAt: Infinity,
  });
  assert.deepEqual(runtime.seen, []);
});

test("a batch the backend keeps failing waits out its own backoff behind fresh batches, and its 8th failure drops it (#193)", async () => {
  const dataDir = tempDataDir();
  const now = Date.now();
  const poison = place(dataDir, entryName(now - 5_000, 2, BINDING, 1), '"poison"');
  const runtime = fakeRuntime((batch) =>
    batch === "poison" ? "failed/export_failed" : "acknowledged"
  );
  const first = await shipSpool(dataDir, BINDING, runtime);
  const [retried] = listed(dataDir);
  assert.match(retried, new RegExp(`-1-${first.nextDueAt}\\.json$`));
  assert.ok(first.nextDueAt - Date.now() > 4_000, "the failed batch is due again in 5 s");
  place(dataDir, entryName(now - 1_000, 2, BINDING, 2), '"live"');
  await shipSpool(dataDir, BINDING, runtime, { limit: 1 });
  assert.deepEqual(runtime.seen, ["poison", "live"]);
  assert.deepEqual(listed(dataDir), [retried]);
  const tries = SPOOL_MAX_TRIES - 1;
  const doomed = place(dataDir, entryName(now - 4_000, 2, BINDING, 3, tries, now), '"poison"');
  const last = await shipSpool(dataDir, BINDING, runtime);
  assert.deepEqual([last.dropped, listed(dataDir).includes(doomed)], [1, false]);
  assert.ok(!listed(dataDir).includes(poison));
});
