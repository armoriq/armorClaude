/* eslint-disable */
/**
 * Audit WAL tests — exercise the on-disk write-ahead log without spinning
 * up the daemon. Covers:
 *   • append/read round-trip
 *   • offset persistence across "restarts" (new wal instance, same dataDir)
 *   • rotation when current.jsonl exceeds size threshold
 *   • crash-replay: rows survive a missing offset advance
 *   • malformed-line skip (the stream doesn't permanently jam)
 *   • disk-full / row-too-large rejection
 *   • concurrent append safety (POSIX O_APPEND atomicity assertion)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAuditWal } from "../scripts/lib/audit-wal.mjs";

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-wal-"));
  return { dir, wal: createAuditWal({ dataDir: dir }) };
}

test("appendLine + readBatch round-trip", async () => {
  const { wal } = await fixture();
  await wal.appendLine({ id: 1, action: "a" });
  await wal.appendLine({ id: 2, action: "b" });
  await wal.appendLine({ id: 3, action: "c" });

  const { rows, endOffset } = await wal.readBatch(100);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[2].action, "c");
  assert.ok(endOffset > 0);
});

test("advanceOffset persists across new wal instance (restart)", async () => {
  const { dir, wal } = await fixture();
  await wal.appendLine({ id: 1 });
  await wal.appendLine({ id: 2 });
  const { rows, endOffset } = await wal.readBatch();
  assert.equal(rows.length, 2);
  await wal.advanceOffset(endOffset);

  // Simulate process restart: brand new wal handle, same dir.
  const wal2 = createAuditWal({ dataDir: dir });
  const second = await wal2.readBatch();
  assert.equal(second.rows.length, 0, "shipped rows should not be re-read");

  await wal2.appendLine({ id: 3 });
  const third = await wal2.readBatch();
  assert.equal(third.rows.length, 1);
  assert.equal(third.rows[0].id, 3);
});

test("crash-replay: missing advance leaves rows for next read", async () => {
  const { dir, wal } = await fixture();
  await wal.appendLine({ id: 1 });
  await wal.appendLine({ id: 2 });
  // Read but don't advance — simulating crash between disk write and ack.
  await wal.readBatch();

  const wal2 = createAuditWal({ dataDir: dir });
  const { rows } = await wal2.readBatch();
  assert.equal(rows.length, 2, "uncommitted rows are replayed");
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2]
  );
});

test("rotation: oversize triggers archive + offset reset", async () => {
  const { dir } = await fixture();
  const wal = createAuditWal({ dataDir: dir, rotateBytes: 200 });

  // Each row ~50 bytes; 6 rows ~= 300 bytes (over the 200-byte cap)
  for (let i = 0; i < 6; i++) {
    await wal.appendLine({ id: i, pad: "x".repeat(20) });
  }
  const { rows, endOffset } = await wal.readBatch(100);
  assert.equal(rows.length, 6);
  await wal.advanceOffset(endOffset); // ships + triggers rotation

  // current.jsonl should be gone or empty; an archive segment should exist.
  const archiveDir = wal._paths.archiveDir;
  const archived = readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl"));
  assert.equal(archived.length, 1, "rotation creates one archive segment");

  // Offset reset to 0; next append starts fresh.
  assert.equal(await wal.readShippedOffset(), 0);
  await wal.appendLine({ id: 99 });
  const after = await wal.readBatch();
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].id, 99);
});

test("malformed line is skipped, not blocking the stream", async () => {
  const { dir, wal } = await fixture();
  await wal.appendLine({ id: 1 });
  // Manually append garbage to simulate a torn write from an older build
  // (current daemon never does this — append is atomic — but defensive).
  const fs = await import("node:fs/promises");
  await fs.appendFile(wal._paths.currentPath, "this is not json\n", "utf8");
  await wal.appendLine({ id: 3 });

  const { rows } = await wal.readBatch();
  assert.equal(rows.length, 2, "malformed line skipped, valid rows still returned");
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 3]
  );
});

test("row too large is rejected (cap protects O_APPEND atomicity)", async () => {
  const { wal } = await fixture();
  const huge = { pad: "x".repeat(5000) }; // > 4000 byte cap
  await assert.rejects(() => wal.appendLine(huge), /too large/);
});

test("readBatch returns rows in enqueue order even when disk order is scrambled", async () => {
  const { dir, wal } = await fixture();
  // Issue 10 concurrent appends. Each `appendLine` returns a Promise; awaiting
  // Promise.all serializes the entry points but the underlying fs.appendFile
  // calls race in the kernel — disk order is non-deterministic.
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => wal.appendLine({ logical_step: i, payload: `row-${i}` }))
  );
  const { rows } = await wal.readBatch(20);
  assert.equal(rows.length, 10);
  // After our sort fix, the returned order must match the order in which
  // the appends were initiated (logical_step 0..9).
  assert.deepEqual(
    rows.map((r) => r.logical_step),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    "rows must come back in enqueue order, not disk order"
  );
});

test("readBatch strips internal _seq and _enqueuedAt fields before returning", async () => {
  const { wal } = await fixture();
  await wal.appendLine({ id: 1, action: "echo" });
  const { rows } = await wal.readBatch();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].action, "echo");
  assert.ok(!("_seq" in rows[0]), "_seq must be stripped before shipping");
  assert.ok(!("_enqueuedAt" in rows[0]), "_enqueuedAt must be stripped before shipping");
});

test("concurrent appends from many writers do not interleave", async () => {
  const { dir, wal } = await fixture();
  const N = 50;
  const writers = [];
  for (let i = 0; i < N; i++) {
    // Each "writer" is a separate wal handle, simulating multiple hooks.
    const w = createAuditWal({ dataDir: dir });
    writers.push(w.appendLine({ id: i, action: "concurrent" }));
  }
  await Promise.all(writers);
  const { rows } = await wal.readBatch(N + 5);
  assert.equal(rows.length, N, "all concurrent appends preserved");
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, N, "no rows lost or duplicated");
});

test("pendingBytes shrinks after advanceOffset", async () => {
  const { wal } = await fixture();
  assert.equal(await wal.pendingBytes(), 0);
  await wal.appendLine({ id: 1 });
  await wal.appendLine({ id: 2 });
  const before = await wal.pendingBytes();
  assert.ok(before > 0);

  const { endOffset } = await wal.readBatch();
  await wal.advanceOffset(endOffset);
  const after = await wal.pendingBytes();
  assert.equal(after, 0);
});

test("pruneArchive keeps newest N segments", async () => {
  const { dir } = await fixture();
  const wal = createAuditWal({ dataDir: dir, rotateBytes: 50 });

  // Force several rotations.
  for (let r = 0; r < 8; r++) {
    for (let i = 0; i < 3; i++) {
      await wal.appendLine({ rotation: r, id: i });
    }
    const { endOffset } = await wal.readBatch(100);
    await wal.advanceOffset(endOffset);
  }
  const beforePrune = readdirSync(wal._paths.archiveDir).length;
  assert.ok(beforePrune >= 5);

  await wal.pruneArchive(3);
  const afterPrune = readdirSync(wal._paths.archiveDir).length;
  assert.equal(afterPrune, 3, "only the newest 3 segments retained");
});
