import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { OUTBOX_SIZE_LIMITS, createAuditWal, createOutbox } from "../scripts/lib/audit-wal.mjs";

const defaultBinding = { backend: "https://a.invalid", keyId: "0123456789abcdef" };
const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-wal-"));
  dirs.push(dir);
  return {
    dir,
    wal: createOutbox({ dataDir: dir, login: "0123456789abcdef", binding: defaultBinding }),
  };
}

async function legacyFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-wal-"));
  return { dir, wal: createAuditWal({ dataDir: dir, login: "0123456789abcdef" }) };
}

test("appendLine + readBatch round-trip", async () => {
  const { wal } = await legacyFixture();
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
  const { dir, wal } = await legacyFixture();
  await wal.appendLine({ id: 1 });
  await wal.appendLine({ id: 2 });
  const { rows, endOffset } = await wal.readBatch();
  assert.equal(rows.length, 2);
  await wal.advanceOffset(endOffset);

  const wal2 = createAuditWal({ dataDir: dir, login: "0123456789abcdef" });
  const second = await wal2.readBatch();
  assert.equal(second.rows.length, 0, "shipped rows should not be re-read");

  await wal2.appendLine({ id: 3 });
  const third = await wal2.readBatch();
  assert.equal(third.rows.length, 1);
  assert.equal(third.rows[0].id, 3);
});

test("crash-replay: missing advance leaves rows for next read", async () => {
  const { dir, wal } = await legacyFixture();
  await wal.appendLine({ id: 1 });
  await wal.appendLine({ id: 2 });
  await wal.readBatch();

  const wal2 = createAuditWal({ dataDir: dir, login: "0123456789abcdef" });
  const { rows } = await wal2.readBatch();
  assert.equal(rows.length, 2, "uncommitted rows are replayed");
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2]
  );
});

test("rotation: oversize triggers archive + offset reset", async () => {
  const { dir } = await legacyFixture();
  const wal = createAuditWal({ dataDir: dir, login: "0123456789abcdef", rotateBytes: 200 });

  for (let i = 0; i < 6; i++) {
    await wal.appendLine({ id: i, pad: "x".repeat(20) });
  }
  const { rows, endOffset } = await wal.readBatch(100);
  assert.equal(rows.length, 6);
  await wal.advanceOffset(endOffset);

  const archiveDir = wal._paths.archiveDir;
  const archived = readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl"));
  assert.equal(archived.length, 1, "rotation creates one archive segment");

  assert.equal(await wal.readShippedOffset(), 0);
  await wal.appendLine({ id: 99 });
  const after = await wal.readBatch();
  assert.equal(after.rows.length, 1);
  assert.equal(after.rows[0].id, 99);
});

test("malformed line is skipped, not blocking the stream", async () => {
  const { wal } = await legacyFixture();
  await wal.appendLine({ id: 1 });
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
  const { wal } = await legacyFixture();
  const huge = { pad: "x".repeat(5000) };
  await assert.rejects(() => wal.appendLine(huge), /too large/);
});

test("readBatch returns rows in enqueue order even when disk order is scrambled", async () => {
  const { wal } = await legacyFixture();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => wal.appendLine({ logical_step: i, payload: `row-${i}` }))
  );
  const { rows } = await wal.readBatch(20);
  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.map((r) => r.logical_step),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    "rows must come back in enqueue order, not disk order"
  );
});

test("readBatch strips internal _seq and _enqueuedAt fields before returning", async () => {
  const { wal } = await legacyFixture();
  await wal.appendLine({ id: 1, action: "echo" });
  const { rows } = await wal.readBatch();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].action, "echo");
  assert.ok(!("_seq" in rows[0]), "_seq must be stripped before shipping");
  assert.ok(!("_enqueuedAt" in rows[0]), "_enqueuedAt must be stripped before shipping");
});

test("concurrent appends from many writers do not interleave", async () => {
  const { dir, wal } = await legacyFixture();
  const N = 50;
  const writers = [];
  for (let i = 0; i < N; i++) {
    const w = createAuditWal({ dataDir: dir, login: "0123456789abcdef" });
    writers.push(w.appendLine({ id: i, action: "concurrent" }));
  }
  await Promise.all(writers);
  const { rows } = await wal.readBatch(N + 5);
  assert.equal(rows.length, N, "all concurrent appends preserved");
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, N, "no rows lost or duplicated");
});

test("pendingBytes shrinks after advanceOffset", async () => {
  const { wal } = await legacyFixture();
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
  const { dir } = await legacyFixture();
  const wal = createAuditWal({ dataDir: dir, login: "0123456789abcdef", rotateBytes: 50 });

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

// regression: #0010
test("the installed queue stays below conmap-auto's shared size contract", async () => {
  const contract = JSON.parse(
    await readFile(new URL("./fixtures/block-capture-v1.json", import.meta.url), "utf8")
  );
  assert.deepEqual(OUTBOX_SIZE_LIMITS, { ...contract.sizeLimits, maxRowBytes: 4000 });
});

test("appendLine + readPending round-trip", async () => {
  const { wal } = await fixture();
  await wal.appendLine({ id: 1, action: "a" });
  await wal.appendLine({ id: 2, action: "b" });
  await wal.appendLine({ id: 3, action: "c" });

  const rows = (await wal.readPending()).map(({ row }) => row);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[2].action, "c");
});

test("malformed line is skipped, not blocking the stream", async () => {
  const { wal } = await fixture();
  await wal.appendLine({ id: 1 });
  const fs = await import("node:fs/promises");
  await fs.appendFile(wal._paths.currentPath, "this is not json\n", "utf8");
  await wal.appendLine({ id: 3 });

  const rows = (await wal.readPending())
    .filter(({ malformed }) => !malformed)
    .map(({ row }) => row);
  assert.equal(rows.length, 2, "malformed line skipped, valid rows still returned");
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 3]
  );
});

test("readPending returns rows in enqueue order even when disk order is scrambled", async () => {
  const { wal } = await fixture();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => wal.appendLine({ logical_step: i, payload: `row-${i}` }))
  );
  const rows = (await wal.readPending())
    .filter(({ malformed }) => !malformed)
    .map(({ row }) => row);
  assert.equal(rows.length, 10);
  assert.deepEqual(
    rows.map((r) => r.logical_step),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    "rows must come back in enqueue order, not disk order"
  );
});

test("readPending strips internal _seq and _enqueuedAt fields before returning", async () => {
  const { wal } = await fixture();
  await wal.appendLine({ id: 1, action: "echo", _seq: 1, _enqueuedAt: 7 });
  const rows = (await wal.readPending())
    .filter(({ malformed }) => !malformed)
    .map(({ row }) => row);
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
    const w = createOutbox({ dataDir: dir, login: "0123456789abcdef" });
    writers.push(w.appendLine({ id: i, action: "concurrent" }));
  }
  await Promise.all(writers);
  const rows = (await wal.readPending())
    .filter(({ malformed }) => !malformed)
    .map(({ row }) => row);
  assert.equal(rows.length, N, "all concurrent appends preserved");
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, N, "no rows lost or duplicated");
});

// regression: #0010
test("status does not turn malformed input into a write or a dead letter", async () => {
  const { wal } = await fixture();
  await wal.appendLine({ tool: "Read" });
  await appendFile(wal._paths.currentPath, "broken row\n");
  const before = await readFile(wal._paths.offsetPath, "utf8");
  assert.equal((await wal.status()).undeliverable, 2);
  assert.deepEqual(await wal.readDeadLetters(), []);
  assert.equal(await readFile(wal._paths.offsetPath, "utf8"), before);
});

// regression: #0010
test("a released cursor beyond its current segment cannot skip newly captured records", async () => {
  for (const legacy of ["", JSON.stringify({ tool: "Legacy" }) + "\n"]) {
    const { dir } = await fixture();
    const login = "0123456789abcdef";
    const root = path.join(dir, "audit", login);
    await mkdir(root, { recursive: true });
    if (legacy) await writeFile(path.join(root, "current.jsonl"), legacy);
    await writeFile(path.join(root, "shipped.offset"), "10000");
    const wal = createOutbox({ dataDir: dir, login, binding: defaultBinding });
    await wal.appendLine({ tool: "New" });
    assert.deepEqual(
      (await wal.readPending()).map(({ row }) => row.tool),
      legacy ? ["Legacy", "New"] : ["New"]
    );
  }
});

// regression: #0010
test("reading the previous bound outbox preserves dead letters and leaves the released cursor untouched", async () => {
  for (const hasJournal of [true, false]) {
    const { dir } = await fixture();
    const root = path.join(dir, "audit", defaultBinding.keyId);
    await mkdir(root, { recursive: true });
    const pending = { client_row_id: randomUUID(), tool: "Legacy pending" };
    const dead = {
      row: { client_row_id: randomUUID(), metadata: "x".repeat(5000) },
      reason: "oversize",
      attempts: 0,
    };
    const line = JSON.stringify(pending) + "\n";
    if (hasJournal) await writeFile(path.join(root, "current.jsonl"), line);
    const releasedState = JSON.stringify({
      version: 1,
      binding: defaultBinding,
      active: "current.jsonl",
      offset: 0,
      settled: [],
      attempts: {},
      identities: {},
      dead: [dead],
      paused: false,
      lease: null,
      revision: null,
    });
    await writeFile(path.join(root, "shipped.offset"), releasedState);
    const wal = createOutbox({
      dataDir: dir,
      login: defaultBinding.keyId,
      binding: defaultBinding,
    });
    await wal.appendLine({ tool: "New pending" });
    assert.deepEqual(
      (await wal.readPending()).map(({ row }) => row.tool),
      hasJournal ? ["Legacy pending", "New pending"] : ["New pending"]
    );
    assert.deepEqual(await wal.readDeadLetters(), [dead]);
    assert.equal(await readFile(path.join(root, "shipped.offset"), "utf8"), releasedState);
    assert.ok((await stat(wal._paths.offsetPath)).size < 4096);
  }
});
