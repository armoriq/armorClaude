import test, { after } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

import {
  AUDIT_SIZE_LIMITS,
  auditStatus,
  createAuditWal,
  recordCaptureFailure,
} from "../scripts/lib/audit-wal.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";

const defaultBinding = { backend: "https://a.invalid", keyId: "0123456789abcdef" };
const dirs = [];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));
const deliver = (wal) =>
  wal.drain(async () => ({ status: 200, body: { failures: [] } }), {
    resolveLogin: () => defaultBinding,
  });

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "armorclaude-wal-"));
  dirs.push(dir);
  return {
    dir,
    wal: createAuditWal({ dataDir: dir, login: "0123456789abcdef", binding: defaultBinding }),
  };
}

// regression: #0010
test("the installed queue stays below conmap-auto's shared size contract", async () => {
  const contract = JSON.parse(
    await readFile(new URL("./fixtures/block-capture-v1.json", import.meta.url), "utf8")
  );
  assert.deepEqual(AUDIT_SIZE_LIMITS, { ...contract.sizeLimits, maxRowBytes: 4000 });
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

test("drain persists across new wal instance (restart)", async () => {
  const { dir, wal } = await fixture();
  await wal.appendLine({ id: 1 });
  await wal.appendLine({ id: 2 });
  const rows = (await wal.readPending()).map(({ row }) => row);
  assert.equal(rows.length, 2);
  await deliver(wal);

  const wal2 = createAuditWal({ dataDir: dir, login: "0123456789abcdef" });
  const second = await wal2.readPending();
  assert.equal(second.length, 0, "shipped rows should not be re-read");

  await wal2.appendLine({ id: 3 });
  const third = (await wal2.readPending()).map(({ row }) => row);
  assert.equal(third.length, 1);
  assert.equal(third[0].id, 3);
});

test("crash-replay: missing advance leaves rows for next read", async () => {
  const { dir, wal } = await fixture();
  await wal.appendLine({ id: 1 });
  await wal.appendLine({ id: 2 });
  await wal.readPending();

  const wal2 = createAuditWal({ dataDir: dir, login: "0123456789abcdef" });
  const rows = (await wal2.readPending()).map(({ row }) => row);
  assert.equal(rows.length, 2, "uncommitted rows are replayed");
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2]
  );
});

test("rotation: oversize triggers archive + offset reset", async () => {
  const { dir } = await fixture();
  const wal = createAuditWal({
    dataDir: dir,
    login: "0123456789abcdef",
    binding: defaultBinding,
    rotateBytes: 200,
  });

  for (let i = 0; i < 6; i++) {
    await wal.appendLine({ id: i, pad: "x".repeat(20) });
  }
  const rows = (await wal.readPending()).map(({ row }) => row);
  assert.equal(rows.length, 6);
  await deliver(wal);

  const archiveDir = wal._paths.archiveDir;
  const archived = readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl"));
  assert.equal(archived.length, 1, "rotation creates one archive segment");

  await wal.appendLine({ id: 99 });
  const after = (await wal.readPending()).map(({ row }) => row);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 99);
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

test("metadata over the shared cap is retained as an oversize dead letter", async () => {
  const { wal } = await fixture();
  const huge = { pad: "x".repeat(300_000) };
  await wal.appendLine(huge);
  assert.deepEqual(
    (await wal.readPending()).map(({ row }) => row),
    []
  );
  assert.deepEqual(
    (await wal.readDeadLetters()).map(({ row, reason, attempts }) => ({ row, reason, attempts })),
    [{ row: huge, reason: "oversize", attempts: 0 }]
  );
});

test("dead letters and the immutable login binding survive reopening with private file modes", async () => {
  const { dir } = await fixture();
  const binding = { backend: "https://a.invalid", keyId: "key-a" };
  const opts = { dataDir: dir, login: "0123456789abcdef", binding };
  const wal = createAuditWal(opts);
  await wal.appendLine({ client_row_id: "row-a", tool: "Bash", input: {} });
  await wal.drain(
    async ({ rows }) => ({
      status: 200,
      body: {
        results: rows.map(({ client_row_id }) => ({
          client_row_id,
          outcome: "rejected",
          error: "invalid tool",
        })),
      },
    }),
    { resolveLogin: () => binding }
  );
  const recovered = createAuditWal(opts);
  assert.equal((await recovered.readDeadLetters()).length, 1);
  assert.equal((await stat(wal._paths.offsetPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(wal._paths.currentPath))).mode & 0o777, 0o700);
  const stored = await readFile(wal._paths.offsetPath, "utf8");
  assert.ok(stored.includes("key-a"));
  await assert.rejects(
    () => createAuditWal({ ...opts, binding: { ...binding, keyId: "key-b" } }).appendLine({}),
    /binding/
  );
});

test("legacy rows keep their original login and acknowledged prefix across migration", async () => {
  const { dir, wal } = await fixture();
  const rows = [
    { tool: "Read", _seq: 1, _enqueuedAt: 1 },
    { tool: "Bash", _seq: 2, _enqueuedAt: 2 },
  ];
  await mkdir(path.join(dir, "audit", "0123456789abcdef"), { recursive: true });
  await writeFile(
    path.join(dir, "audit", "0123456789abcdef", "current.jsonl"),
    rows.map((row) => JSON.stringify(row) + "\n").join("")
  );
  await writeFile(
    wal._paths.legacyOffsetPath,
    String(Buffer.byteLength(JSON.stringify(rows[0]) + "\n"))
  );
  const recovered = createAuditWal({ dataDir: dir, login: "0123456789abcdef" });
  assert.deepEqual(
    (await recovered.readPending()).map(({ row }) => row),
    [{ tool: "Bash" }]
  );
  await recovered.drain(() => assert.fail("an unbound legacy row was delivered"));
  assert.equal((await recovered.status()).undeliverable, 1);
});

// regression: #0010
test("bound legacy rows persist one UUID before delivery and settle by results after a restart", async () => {
  const { dir, wal } = await fixture();
  const binding = { backend: "https://a.invalid", keyId: "0123456789abcdef" };
  const options = { dataDir: dir, login: binding.keyId, binding };
  const knownId = randomUUID();
  const rows = [
    { tool: "Already shipped", _seq: 1, _enqueuedAt: 1 },
    ...[undefined, null, "", "invalid", 42].map((client_row_id, index) => ({
      client_row_id,
      tool: "Bash",
      action: "Bash",
      input: { command: `echo ${index}` },
      status: "blocked",
      decision_code: "policy_deny",
      executed_at: "2026-11-14T12:00:00.000Z",
      session_id: "captured-session",
      _seq: index + 2,
      _enqueuedAt: index + 2,
    })),
    { client_row_id: knownId, tool: "Read" },
  ];
  await mkdir(path.join(dir, "audit", "0123456789abcdef"), { recursive: true });
  await writeFile(
    path.join(dir, "audit", "0123456789abcdef", "current.jsonl"),
    rows.map((row) => JSON.stringify(row) + "\n").join("")
  );
  await writeFile(
    wal._paths.legacyOffsetPath,
    JSON.stringify({
      version: 1,
      binding,
      active: "current.jsonl",
      offset: Buffer.byteLength(JSON.stringify(rows[0]) + "\n"),
      settled: [],
      attempts: {},
      identities: {},
      dead: [],
      paused: false,
      lease: null,
      revision: null,
    })
  );
  const releasedOffset = await readFile(wal._paths.legacyOffsetPath, "utf8");
  const releasedPath = path.join(dir, "audit", binding.keyId, "current.jsonl");
  const releasedStat = await stat(releasedPath);
  const lateRow = { client_row_id: randomUUID(), tool: "Appended during delivery" };
  let resolutions = 0;
  await assert.rejects(
    () =>
      createAuditWal(options).drain(() => assert.fail("sent before the restart"), {
        resolveLogin() {
          if (++resolutions === 2) throw new Error("restart before delivery");
          return binding;
        },
      }),
    /restart before delivery/
  );
  const recovered = createAuditWal(options);
  const assigned = (await recovered.readPending()).map(({ row }) => row);
  const ids = assigned.map(({ client_row_id }) => client_row_id);
  for (const id of ids.slice(0, -1))
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, rows.length - 1);
  assert.equal(ids.at(-1), knownId);
  assert.deepEqual(
    assigned,
    rows.slice(1).map((original, index) => {
      const row = { ...original, client_row_id: ids[index] };
      delete row._seq;
      delete row._enqueuedAt;
      return row;
    })
  );
  await recovered.drain(
    async ({ login, rows: outbound }) => {
      assert.deepEqual(login, binding);
      assert.deepEqual(outbound, assigned);
      assert.deepEqual(
        (await createAuditWal(options).readPending()).map(({ row }) => row),
        assigned
      );
      await appendFile(releasedPath, JSON.stringify(lateRow) + "\n");
      return {
        status: 200,
        body: {
          results: [...outbound].reverse().map(({ client_row_id }) => ({
            client_row_id,
            outcome: "accepted",
          })),
        },
      };
    },
    { resolveLogin: () => binding }
  );
  assert.deepEqual(
    (await createAuditWal(options).readPending()).map(({ row }) => row),
    [lateRow]
  );
  await createAuditWal(options).drain(
    async ({ login, rows: outbound }) => {
      assert.deepEqual(login, binding);
      assert.deepEqual(outbound, [lateRow]);
      return { status: 200, body: { failures: [] } };
    },
    { resolveLogin: () => binding }
  );
  assert.deepEqual(await createAuditWal(options).readPending(), []);
  assert.equal(await readFile(wal._paths.legacyOffsetPath, "utf8"), releasedOffset);
  assert.equal((await stat(releasedPath)).ino, releasedStat.ino);
  assert.equal((await stat(releasedPath)).mode, releasedStat.mode);
  assert.equal(
    await readFile(releasedPath, "utf8"),
    [...rows, lateRow].map((row) => JSON.stringify(row) + "\n").join("")
  );
});

test("batch_oversize outcomes split and resend without losing accepted rows", async () => {
  const { dir } = await fixture();
  const binding = { backend: "https://a.invalid", keyId: "key-a" };
  const wal = createAuditWal({ dataDir: dir, login: "0123456789abcdef", binding });
  const [one, two, three] = Array.from({ length: 3 }, () => randomUUID());
  for (const client_row_id of [one, two, three])
    await wal.appendLine({ client_row_id, tool: "Bash" });
  const sizes = [];
  await wal.drain(
    async ({ rows }) => {
      sizes.push(rows.length);
      return {
        status: 200,
        body: {
          results: rows.map(({ client_row_id }) => ({
            client_row_id,
            outcome: rows.length > 1 || client_row_id !== one ? "retryable" : "accepted",
            ...(rows.length > 1 ? { error: "batch_oversize" } : { error: "busy" }),
          })),
        },
      };
    },
    { resolveLogin: () => binding }
  );
  assert.deepEqual(sizes, [3, 1, 2, 1, 1]);
  assert.deepEqual(
    (await wal.readPending()).map(({ row, attempts }) => [row.client_row_id, attempts]),
    [
      [two, 0],
      [three, 0],
    ]
  );
});

// regression: #0010
test("batch resizing keeps Retry-After across restart before resending smaller requests", async () => {
  const { dir } = await fixture();
  let now = 1_000;
  const binding = { backend: "https://a.invalid", keyId: "key-a" };
  const options = {
    dataDir: dir,
    login: "0123456789abcdef",
    binding,
    clock: { now: () => now, random: () => 0.5 },
  };
  const wal = createAuditWal(options);
  for (const client_row_id of ["one", "two"]) await wal.appendLine({ client_row_id, tool: "Read" });
  let sends = 0;
  await wal.drain(
    async ({ rows }) => {
      sends += 1;
      return {
        status: 429,
        headers: { "retry-after": "120" },
        body: {
          results: rows.map(({ client_row_id }) => ({
            client_row_id,
            outcome: "retryable",
            error: "batch_oversize",
          })),
        },
      };
    },
    { resolveLogin: () => binding }
  );
  assert.equal(sends, 1);
  const recovered = createAuditWal(options);
  await recovered.drain(() => assert.fail("sent before Retry-After"), {
    resolveLogin: () => binding,
  });
  now += 120_000;
  const sizes = [];
  await recovered.drain(
    async ({ rows }) => {
      sizes.push(rows.length);
      return { status: 200, body: { failures: [] } };
    },
    { resolveLogin: () => binding }
  );
  assert.deepEqual(sizes, [1, 1]);
  assert.deepEqual(await recovered.readPending(), []);
  for (let n = 0; n < 3; n += 1)
    await recovered.appendLine({ client_row_id: randomUUID(), tool: "Healthy" });
  const healthySizes = [];
  await recovered.drain(
    async ({ rows }) => {
      healthySizes.push(rows.length);
      return { status: 200, body: { failures: [] } };
    },
    { resolveLogin: () => binding }
  );
  assert.deepEqual(healthySizes, [3]);
});

test("an accepted tenth delivery whose acknowledgement failed is recovered without a false dead letter or an eleventh send", async () => {
  const { dir } = await fixture();
  const binding = { backend: "https://a.invalid", keyId: "key-a" };
  let now = 1_000;
  let fault = null;
  const options = {
    dataDir: dir,
    login: "0123456789abcdef",
    binding,
    clock: { now: () => now, random: () => 0.5 },
    beforeCommit(point) {
      if (fault === point) {
        fault = null;
        throw new Error("injected ack failure");
      }
    },
  };
  const wal = createAuditWal(options);
  await wal.appendLine({ client_row_id: "one", tool: "Read" });
  for (let attempt = 1; attempt < 10; attempt += 1) {
    await wal.drain(async () => ({ status: 409, body: {} }), { resolveLogin: () => binding });
    now = (await wal.readPending())[0].nextAttemptAt;
  }
  fault = "ack";
  await assert.rejects(
    () =>
      wal.drain(async () => ({ status: 200, body: { failures: [] } }), {
        resolveLogin: () => binding,
      }),
    /injected/
  );
  const recovered = createAuditWal(options);
  assert.equal((await recovered.readPending())[0].attempts, 9);
  await recovered.drain(() => assert.fail("sent an eleventh time"), {
    resolveLogin: () => binding,
  });
  assert.deepEqual(await recovered.readPending(), []);
  assert.deepEqual(await recovered.readDeadLetters(), []);
});

test("local status counts pending rows without a login, dead letters and capture failures after restart", async () => {
  const { dir, wal } = await fixture();
  await wal.appendLine({ client_row_id: "pending", tool: "Read" });
  await wal.appendLine({ client_row_id: "oversize", metadata: "x".repeat(300_000) });
  await recordCaptureFailure(dir, "internal_error");
  const shipped = JSON.stringify({ tool: "Already shipped" }) + "\n";
  await writeFile(
    path.join(dir, "audit", "current.jsonl"),
    shipped + JSON.stringify({ tool: "Unbound pending" }) + "\n"
  );
  await writeFile(path.join(dir, "audit", "shipped.offset"), String(Buffer.byteLength(shipped)));
  assert.deepEqual(await auditStatus(dir), {
    undeliverable: 2,
    olderVersion: 1,
    deadLetters: 1,
    captureFailures: 1,
  });
  const output = await handleArmorPolicyCommand("/armor status", { dataDir: dir });
  assert.match(output, /Undeliverable: 2/);
  assert.match(output, /Written by an older version and not sent by this version: 1/);
  assert.match(output, /Dead letters: 1/);
  assert.match(output, /Capture failures: 1/);
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
    const w = createAuditWal({ dataDir: dir, login: "0123456789abcdef" });
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

test("a separate process owns the delivery lease and its acknowledgement preserves another process's append", async (t) => {
  const { dir } = await fixture();
  const binding = { backend: "https://a.invalid", keyId: "key-a" };
  const options = { dataDir: dir, login: "0123456789abcdef", binding };
  const wal = createAuditWal(options);
  await wal.appendLine({ client_row_id: "first", tool: "Read" });
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createAuditWal } from ${JSON.stringify(new URL("../scripts/lib/audit-wal.mjs", import.meta.url).href)};
    const options = JSON.parse(process.argv[1]);
    const wal = createAuditWal(options);
    await wal.drain(async ({ rows }) => {
      process.stdout.write("sending\\n");
      await new Promise((resolve) => process.stdin.once("data", resolve));
      return { status: 200, body: { failures: [] } };
    }, { resolveLogin: () => options.binding });
  `,
      JSON.stringify(options),
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  const exited = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const lines = createInterface({ input: child.stdout });
  await Promise.race([
    once(lines, "line"),
    exited.then(() => {
      throw new Error("drainer exited before delivery");
    }),
  ]);
  try {
    await wal.drain(() => assert.fail("a second process sent while the lease was live"), {
      resolveLogin: () => binding,
    });
    await wal.appendLine({ client_row_id: "second", tool: "Write" });
  } finally {
    child.stdin.end("reply");
  }
  assert.equal((await exited)[0], 0);
  assert.deepEqual(
    (await wal.readPending()).map(({ row }) => row.client_row_id),
    ["second"]
  );
});

test("pendingBytes shrinks after drain", async () => {
  const { wal } = await fixture();
  assert.equal(await wal.pendingBytes(), 0);
  await wal.appendLine({ id: 1 });
  await wal.appendLine({ id: 2 });
  const before = await wal.pendingBytes();
  assert.ok(before > 0);

  await deliver(wal);
  const after = await wal.pendingBytes();
  assert.equal(after, 0);
});

// regression: #0010
test("rotation keeps every delivered segment", async () => {
  const { dir } = await fixture();
  const wal = createAuditWal({
    dataDir: dir,
    login: "0123456789abcdef",
    binding: defaultBinding,
    rotateBytes: 50,
  });

  for (let r = 0; r < 8; r++) {
    for (let i = 0; i < 3; i++) {
      await wal.appendLine({ rotation: r, id: i });
    }
    await deliver(wal);
  }
  assert.equal(readdirSync(wal._paths.archiveDir).length, 8, "every delivered segment is retained");
  await wal.pruneArchive(3);
  const retained = (
    await Promise.all(
      readdirSync(wal._paths.archiveDir, { recursive: true })
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => readFile(path.join(wal._paths.archiveDir, name), "utf8"))
    )
  )
    .join("")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(retained.length, 24);
});

// regression: #0010
test("a released 0.2.19 reader cannot resend new rows or overwrite their dead letters", async () => {
  const { dir } = await fixture();
  const login = "0123456789abcdef";
  const legacyDir = path.join(dir, "audit", login);
  await mkdir(legacyDir, { recursive: true });
  const shipped = JSON.stringify({ tool: "Already shipped", _seq: 1, _enqueuedAt: 1 }) + "\n";
  const legacyPending = JSON.stringify({ tool: "Legacy pending", _seq: 2, _enqueuedAt: 2 }) + "\n";
  const currentPath = path.join(legacyDir, "current.jsonl");
  const offsetPath = path.join(legacyDir, "shipped.offset");
  await writeFile(currentPath, shipped + legacyPending);
  await writeFile(offsetPath, String(Buffer.byteLength(shipped)));
  const binding = { backend: "https://a.invalid", keyId: login };
  const options = { dataDir: dir, login, binding };
  const wal = createAuditWal(options);
  await wal.appendLine({ client_row_id: randomUUID(), tool: "Rejected" });
  await wal.appendLine({ client_row_id: randomUUID(), metadata: "x".repeat(300_000) });
  await wal.drain(
    async ({ rows }) => ({
      status: 200,
      body: {
        results: rows.map(({ client_row_id }) => ({
          client_row_id,
          outcome: "rejected",
          error: "bad row",
        })),
      },
    }),
    { resolveLogin: () => binding }
  );
  const pending = { client_row_id: randomUUID(), tool: "Pending" };
  await wal.appendLine(pending);
  const rawOffset = await readFile(offsetPath, "utf8");
  assert.ok(/^\d+$/.test(rawOffset), "released cursor must remain a decimal number");
  // Released armorClaude 0.2.19 (1f91f0c) reads parseInt(offset), then current.jsonl from that byte.
  const n = Number.parseInt(rawOffset.trim(), 10);
  const offset = Number.isFinite(n) && n >= 0 ? n : 0;
  const buffer = await readFile(currentPath);
  const oldRows = buffer
    .subarray(offset)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.deepEqual(oldRows, [{ tool: "Legacy pending", _seq: 2, _enqueuedAt: 2 }]);
  assert.equal((await wal.status(() => binding)).olderVersion, 1);
  assert.equal(await readFile(offsetPath, "utf8"), String(Buffer.byteLength(shipped)));
  await writeFile(offsetPath, String(offset + Buffer.byteLength(buffer.subarray(offset))));
  const recovered = createAuditWal(options);
  assert.deepEqual(
    (await recovered.readPending()).map(({ row }) => row),
    [pending]
  );
  assert.equal((await recovered.readDeadLetters()).length, 2);
  assert.equal(await readFile(currentPath, "utf8"), shipped + legacyPending);
});

// regression: #0010
test("a long transport outage never exhausts rows and every captured row is delivered after recovery", async (t) => {
  for (const failure of ["network", "timeout", 503, 429]) {
    await t.test(String(failure), async () => {
      const { dir } = await fixture();
      const binding = { backend: "https://a.invalid", keyId: "key-a" };
      let now = 1_000;
      const options = {
        dataDir: dir,
        login: "0123456789abcdef",
        binding,
        clock: { now: () => now, random: () => 0.5 },
      };
      let wal = createAuditWal(options);
      const captured = Array.from({ length: 12 }, () => ({
        client_row_id: randomUUID(),
        tool: "Read",
      }));
      for (const row of captured) await wal.appendLine(row);
      for (let retry = 0; retry < 40; retry += 1) {
        await wal.drain(
          async () => {
            if (failure === "network") throw new Error("connection lost");
            if (failure === "timeout")
              throw Object.assign(new Error("request timed out"), { name: "TimeoutError" });
            return { status: failure, body: {} };
          },
          { resolveLogin: () => binding }
        );
        wal = createAuditWal(options);
        const pending = await wal.readPending();
        assert.equal(pending.length, captured.length);
        assert.ok(pending.every(({ attempts }) => attempts === 0));
        const next = Math.max(...pending.map(({ nextAttemptAt }) => nextAttemptAt));
        assert.ok(next > now && next - now <= 300_000);
        now = next;
      }
      assert.ok(now > 30 * 60_000);
      const delivered = [];
      await wal.drain(
        async ({ rows }) => {
          delivered.push(...rows);
          return { status: 200, body: { failures: [] } };
        },
        { resolveLogin: () => binding }
      );
      assert.deepEqual(delivered, captured);
      assert.deepEqual(await wal.readPending(), []);
      assert.deepEqual(await wal.readDeadLetters(), []);
    });
  }
});

// regression: #0010
test("settled history compacts and dead letter history stays off append, restore and idle drain paths", async () => {
  const { dir } = await fixture();
  const binding = { backend: "https://a.invalid", keyId: "key-a" };
  const wal = createAuditWal({ dataDir: dir, login: "0123456789abcdef", binding });
  for (let n = 0; n < 100; n += 1)
    await wal.appendLine({ client_row_id: randomUUID(), metadata: "x".repeat(20_000) });
  for (let n = 0; n < 200; n += 1)
    await wal.appendLine({ client_row_id: randomUUID(), tool: "Read" });
  await wal.drain(async () => ({ status: 200, body: { failures: [] } }), {
    resolveLogin: () => binding,
  });
  const statePath = path.join(dir, "audit", "0123456789abcdef", "outbox-state.json");
  const deadPath = path.join(dir, "audit", "0123456789abcdef", "dead-letters.jsonl");
  await wal.restoreLogin("same-login");
  const before = await stat(statePath);
  const dead = await stat(deadPath);
  assert.ok(before.size < 4096);
  assert.ok(dead.size > 2_000_000);
  await wal.restoreLogin("same-login");
  await wal.drain(() => assert.fail("an idle drain sent rows"), { resolveLogin: () => binding });
  await wal.appendLine({ client_row_id: randomUUID(), tool: "Write" });
  assert.equal((await stat(statePath)).ino, before.ino);
  assert.equal((await stat(deadPath)).size, dead.size);
  assert.equal((await wal.status()).deadLetters, 100);
  assert.equal((await stat(deadPath)).mode & 0o777, 0o600);
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
test("the shipped row keeps the base 4000 byte content cap", async () => {
  const { wal } = await fixture();
  const row = {
    client_row_id: randomUUID(),
    tool: "Write",
    input: { content: "x".repeat(5000) },
    executed_at: "2026-11-18T00:00:00.000Z",
  };
  await wal.appendLine(row);
  const [pending] = await wal.readPending();
  assert.deepEqual(pending.row, { ...row, input: { truncated: true } });
  assert.ok(Buffer.byteLength(JSON.stringify(pending.row)) <= 4000);
});

// regression: #0010
test("a dead letter committed before settlement recovers once after a storage failure", async () => {
  const { dir } = await fixture();
  const binding = { backend: "https://a.invalid", keyId: "key-a" };
  let fail = true;
  const options = {
    dataDir: dir,
    login: "0123456789abcdef",
    binding,
    beforeCommit(point) {
      if (point === "deadLetterWritten" && fail) {
        fail = false;
        throw new Error("storage failed after dead letter sync");
      }
    },
  };
  const wal = createAuditWal(options);
  const row = { client_row_id: randomUUID(), tool: "Read" };
  await wal.appendLine(row);
  await assert.rejects(
    () =>
      wal.drain(
        async ({ rows }) => ({
          status: 200,
          body: {
            results: rows.map(({ client_row_id }) => ({
              client_row_id,
              outcome: "rejected",
              error: "invalid",
            })),
          },
        }),
        { resolveLogin: () => binding }
      ),
    /storage failed/
  );
  const recovered = createAuditWal(options);
  assert.deepEqual(await recovered.readPending(), []);
  assert.deepEqual(await recovered.readDeadLetters(), [{ row, reason: "invalid", attempts: 1 }]);
  assert.equal((await recovered.status()).deadLetters, 1);
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
    const wal = createAuditWal({ dataDir: dir, login, binding: defaultBinding });
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
    const wal = createAuditWal({
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

// regression: #0010
test("a released drainer keeps every unbound row while the new queue scans, replays and drains alongside it", async (t) => {
  const { dir } = await fixture();
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createAuditWal } from ${JSON.stringify(new URL("./helpers/released-audit-wal-0.2.19.mjs", import.meta.url).href)};
    import { createInterface } from 'node:readline';
    const wal = createAuditWal(${JSON.stringify({ dataDir: dir, login: defaultBinding.keyId, rotateBytes: 1 })});
    for await (const line of createInterface({ input: process.stdin })) {
      const command = JSON.parse(line);
      let rows = [];
      if (command.row) await wal.appendLine(command.row);
      else {
        const batch = await wal.readBatch();
        rows = batch.rows;
        await wal.advanceOffset(batch.endOffset);
      }
      process.stdout.write(JSON.stringify(rows) + '\\n');
    }
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  const exited = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const responses = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const command = async (value) => {
    child.stdin.write(JSON.stringify(value) + "\n");
    const reply = await Promise.race([
      responses.next(),
      exited.then(() => {
        throw new Error("released drainer exited before its reply");
      }),
    ]);
    return JSON.parse(reply.value);
  };
  const oldRows = Array.from({ length: 4 }, () => ({ id: randomUUID(), tool: "Released" }));
  await command({ row: oldRows[0] });
  let failAck = true;
  const options = {
    dataDir: dir,
    login: defaultBinding.keyId,
    binding: defaultBinding,
    beforeCommit(point) {
      if (point === "ack" && failAck) {
        failAck = false;
        throw new Error("crash before receipt");
      }
    },
  };
  const wal = createAuditWal(options);
  const current = { client_row_id: randomUUID(), tool: "Current" };
  await wal.appendLine(current);
  await Promise.all([command({ row: oldRows[1] }), wal.readPending()]);
  const stored = new Map();
  const send = async ({ rows }) => {
    for (const row of rows) stored.set(row.client_row_id, row);
    return { status: 200, body: { failures: [] } };
  };
  await assert.rejects(
    () =>
      wal.drain(
        async (request) => {
          await command({ row: oldRows[2] });
          return send(request);
        },
        { resolveLogin: () => defaultBinding }
      ),
    /crash before receipt/
  );
  const recovered = createAuditWal(options);
  await recovered.drain(send, { resolveLogin: () => defaultBinding });
  const root = path.join(dir, "audit", defaultBinding.keyId);
  assert.equal(
    await readFile(path.join(root, "shipped.offset"), "utf8").catch((err) => {
      assert.equal(err.code, "ENOENT");
      return null;
    }),
    null
  );
  assert.equal((await recovered.status(() => defaultBinding)).olderVersion, 3);
  assert.deepEqual(await command({ drain: true }), oldRows.slice(0, 3));
  for (const row of oldRows.slice(0, 3)) stored.set(row.id, row);
  assert.equal((await recovered.status(() => defaultBinding)).olderVersion, 0);
  await command({ row: oldRows[3] });
  assert.equal((await recovered.status(() => defaultBinding)).olderVersion, 1);
  assert.deepEqual(await command({ drain: true }), [oldRows[3]]);
  stored.set(oldRows[3].id, oldRows[3]);
  assert.deepEqual([...stored.values()], [current, ...oldRows]);
  assert.deepEqual(await recovered.readPending(), []);
  child.stdin.end();
  assert.equal((await exited)[0], 0);
});
