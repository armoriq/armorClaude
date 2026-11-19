import { after, describe, it } from "node:test";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as outbox from "../scripts/lib/audit-wal.mjs";
import { defineOutboxConformance } from "./helpers/outbox-conformance.template.mjs";
import { handleArmorPolicyCommand } from "../scripts/lib/armor-policy-commands.mjs";

const dirs = [];
const { createAuditWal, loginTag } = outbox;
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function makeAdapter(options, shared) {
  if (!shared) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "armor-outbox-"));
    dirs.push(dataDir);
    shared = { dataDir, current: options.login, bindings: new Map(), fault: null };
  }
  const open = (login) => {
    const tag = loginTag(login.backend, login.keyId);
    shared.bindings.set(tag, { backend: login.backend, keyId: login.keyId });
    return createAuditWal({
      ...options,
      dataDir: shared.dataDir,
      login: tag,
      binding: shared.bindings.get(tag),
      beforeCommit(point) {
        if (shared.fault !== point) return;
        shared.fault = null;
        throw new Error(`injected ${point} storage failure`);
      },
    });
  };
  const all = () => [...shared.bindings.values()].map(open);
  return {
    async append(row, { fallback = false, loggedOut = false } = {}) {
      if (loggedOut) return;
      if (!shared.current) return outbox.recordCaptureFailure(shared.dataDir, row.decision_code);
      await open(shared.current).appendLine(row, { fallback });
    },
    async drain(send, { probe } = {}) {
      if (!shared.current || shared.current.available === false) return;
      await open(shared.current).drain(send, { resolveLogin: () => shared.current, probe });
    },
    async readPending() {
      return (await Promise.all(all().map((wal) => wal.readPending()))).flat();
    },
    async readDeadLetters() {
      return (await Promise.all(all().map((wal) => wal.readDeadLetters()))).flat();
    },
    async status() {
      const { auditStatus } = await import("../scripts/lib/audit-wal.mjs");
      return auditStatus(shared.dataDir, () => shared.current);
    },
    async switchLogin(login) {
      shared.current = login;
      if (login && login.available !== false) await open(login).restoreLogin();
    },
    async authenticationSucceeded(login) {
      for (const wal of all()) await wal.authenticationSucceeded(login);
    },
    async failNext(point) {
      shared.fault = point;
    },
    restart: () => makeAdapter(options, shared),
    secondDrainer: () => makeAdapter(options, shared),
  };
}

defineOutboxConformance({ describe, it, makeAdapter });

async function healthStore() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "armor-health-"));
  dirs.push(dataDir);
  let now = 1_800_000_000_000;
  const binding = { backend: "https://backend.invalid", keyId: "aaaaaaaaaaaaaaaa" };
  const options = {
    dataDir,
    login: binding.keyId,
    binding,
    clock: { now: () => now, random: () => 0 },
    timing: { baseMs: 1, maxMs: 1, healthProbeMs: 30_000 },
  };
  return {
    open: (stream = "audit", extra = {}) => createAuditWal({ ...options, stream, ...extra }),
    advance: (ms) => (now += ms),
    resolveLogin: () => binding,
    binding,
    dataDir,
  };
}

const healthEvent = () => ({
  event_id: randomUUID(),
  type: "plan_request_failed",
  queue: "health",
  count: 1,
  reason_code: "timeout",
  occurred_at: "2026-11-15T00:00:00.000Z",
});
const delivered = async ({ rows }) => ({
  status: 200,
  body: { results: rows.map(({ event_id }) => ({ event_id, outcome: "duplicate" })) },
});

describe("health outbox conformance", () => {
  // regression: #0012
  it("preserves the time of each dead letter before health handoff", async () => {
    const store = await healthStore();
    const audit = store.open();
    for (let n = 0; n < 2; n++) {
      await audit.appendLine({ client_row_id: randomUUID(), metadata: "x".repeat(5000) });
      store.advance(60_000);
    }
    await audit.reportHealth(undefined, store);
    const events = (await store.open("health").readPending()).map(({ row }) => row);
    assert.deepEqual(
      events.map(({ occurred_at, count }) => [occurred_at, count]),
      [
        ["2027-01-15T08:00:00.000Z", 1],
        ["2027-01-15T08:01:00.000Z", 1],
      ]
    );
  });

  // regression: #0012
  it("leaves idle health state untouched", async () => {
    const store = await healthStore();
    const audit = store.open();
    await audit.appendLine({ client_row_id: randomUUID() });
    await audit.drain(
      async ({ rows }) => ({
        status: 200,
        body: { results: rows.map((row) => ({ ...row, outcome: "accepted" })) },
      }),
      store
    );
    const before = await stat(audit._paths.offsetPath);
    await audit.reportHealth(undefined, store);
    await store.open().reportHealth(undefined, store);
    assert.equal((await stat(audit._paths.offsetPath)).ino, before.ino);
  });

  // regression: #0012
  it("keeps malformed bytes local without reporting a backend rejection", async () => {
    const store = await healthStore();
    const audit = store.open();
    await audit.restoreLogin("test-login");
    await appendFile(audit._paths.currentPath, "{malformed\n");
    await audit.drain(() => assert.fail("malformed bytes were sent"), store);
    assert.deepEqual(
      (await audit.readDeadLetters()).map(({ row, reason, attempts }) => [row, reason, attempts]),
      [[{ raw: "{malformed" }, "malformed", 0]]
    );
    await audit.reportHealth(undefined, store);
    assert.deepEqual(await store.open("health").readPending(), []);
  });

  // regression: #0012
  it("holds unexpected audit 4xx responses without exhausting pending rows", async () => {
    for (const status of [404, 405, 410, 418]) {
      const store = await healthStore();
      const audit = store.open();
      const row = { client_row_id: randomUUID() };
      await audit.appendLine(row);
      for (let n = 0; n < 12; n++) {
        await store.open().drain(async () => ({ status, body: {} }), store);
        store.advance(30_000);
      }
      assert.deepEqual(
        (await audit.readPending()).map(({ row, attempts }) => [row, attempts]),
        [[row, 0]],
        String(status)
      );
      assert.deepEqual(await audit.readDeadLetters(), []);
      await audit.drain(async () => ({ status: 200, body: { failures: [] } }), store);
      assert.deepEqual(await audit.readPending(), []);
    }
  });

  it("reports newly moved dead letters after an outage and settles duplicates", async () => {
    const store = await healthStore();
    const audit = store.open();
    for (let i = 0; i < 3; i++) await audit.appendLine({ client_row_id: randomUUID() });
    await audit.drain(
      async ({ rows }) => ({
        status: 200,
        body: {
          results: rows.map(({ client_row_id }) => ({ client_row_id, outcome: "rejected" })),
        },
      }),
      store
    );
    await audit.reportHealth(undefined, store);
    const health = store.open("health");
    const first = await health.readPending();
    assert.equal(first.length, 1);
    assert.equal(first[0].row.type, "dead_letter");
    assert.equal(first[0].row.count, 3);
    assert.equal(first[0].row.reason_code, "rejected");
    await health.drain(async () => {
      throw new Error("offline");
    }, store);
    await store.open().reportHealth(undefined, store);
    assert.equal((await health.readPending()).length, 1);
    store.advance(1);
    await store.open("health").drain(delivered, store);
    assert.deepEqual(await health.readPending(), []);
  });

  // regression: #0012
  it("keeps one hourly stall bookmark per source queue across restarts and logins", async () => {
    const store = await healthStore();
    await store.open().appendLine({ client_row_id: randomUUID() });
    store.advance(60_000);
    await store.open().reportHealth("backend_unreachable", store);
    const other = { backend: store.binding.backend, keyId: "bbbbbbbbbbbbbbbb" };
    const otherWal = store.open("audit", { login: other.keyId, binding: other });
    await otherWal.appendLine({ client_row_id: randomUUID() });
    await otherWal.reportHealth("backend_unreachable", { resolveLogin: () => other });
    await store.open().reportHealth("backend_unreachable", store);
    const health = store.open("health");
    assert.equal((await health.readPending()).length, 1);
    assert.equal(
      (await store.open("health", { login: other.keyId, binding: other }).readPending()).length,
      1
    );
    assert.equal((await health.readPending())[0].row.oldest_pending_seconds, 60);
    store.advance(3_599_999);
    await store.open().reportHealth("rate_limited", store);
    assert.equal((await health.readPending()).length, 1);
    store.advance(1);
    await store.open().reportHealth("rate_limited", store);
    const events = (await health.readPending()).map(({ row }) => row);
    assert.equal(events.length, 2);
    assert.equal(events[1].reason_code, "rate_limited");
    assert.equal(events[1].count, 1);
    assert.equal(events[1].oldest_pending_seconds, 3660);
    assert.ok(!(await readdir(path.join(store.dataDir, "audit"))).includes(".storage-lock"));
  });

  // regression: #0012
  it("counts a dead letter after a crash between the dead letter and state commits", async () => {
    const store = await healthStore();
    let crash = true;
    const audit = store.open("audit", {
      beforeCommit(point) {
        if (point === "deadLetterWritten" && crash) throw new Error("crashed after append");
      },
    });
    await audit
      .appendLine({ client_row_id: randomUUID(), metadata: "x".repeat(5000) })
      .catch((error) => assert.match(error.message, /crashed/));
    crash = false;
    await store.open().reportHealth(undefined, store);
    await store.open().reportHealth(undefined, store);
    const events = (await store.open("health").readPending()).map(({ row }) => row);
    assert.equal((await audit.readDeadLetters()).length, 1);
    assert.deepEqual(
      events.map(({ count, reason_code }) => [count, reason_code]),
      [[1, "oversize"]]
    );
  });

  // regression: #0012
  it("keeps a copied health event immutable while more dead letters are counted", async () => {
    const store = await healthStore();
    const audit = store.open();
    const reject = async ({ rows }) => ({
      status: 200,
      body: { results: rows.map(({ client_row_id }) => ({ client_row_id, outcome: "rejected" })) },
    });
    await audit.appendLine({ client_row_id: randomUUID() });
    await audit.drain(reject, store);
    let fail = true;
    const interrupted = store.open("audit", {
      beforeCommit(point) {
        if (point === "append" && fail) throw new Error("health append interrupted");
      },
    });
    await assert.rejects(interrupted.reportHealth(undefined, store), /interrupted/);
    const source = JSON.parse(await readFile(audit._paths.offsetPath, "utf8"));
    await store.open("health").appendLine(source.healthEvents[0]);
    fail = false;
    await audit.appendLine({ client_row_id: randomUUID() });
    await audit.drain(reject, store);
    await audit.reportHealth(undefined, store);
    const events = (await store.open("health").readPending()).map(({ row }) => row);
    assert.equal(
      events.reduce((sum, event) => sum + event.count, 0),
      2
    );
    assert.equal(new Set(events.map(({ event_id }) => event_id)).size, 2);
  });

  it("persists an endpoint pause without attempts and probes before resuming", async () => {
    const store = await healthStore();
    const health = store.open("health");
    const event = healthEvent();
    await health.appendLine(event);
    await health.drain(async () => ({ status: 404, body: {} }), store);
    const reopened = store.open("health");
    assert.equal((await reopened.status(store.resolveLogin)).paused, true);
    assert.equal((await reopened.readPending())[0].attempts, 0);
    await reopened.drain(() => assert.fail("probe before its persisted time"), store);
    store.advance(30_000);
    await reopened.drain(async () => {
      throw new Error("offline");
    }, store);
    assert.equal((await reopened.status(store.resolveLogin)).paused, true);
    store.advance(30_000);
    await reopened.drain(delivered, store);
    assert.equal((await reopened.status(store.resolveLogin)).paused, false);
    assert.deepEqual(await reopened.readPending(), []);
    await reopened.appendLine(event);
    assert.deepEqual(await reopened.readPending(), []);
  });

  it("reports why delivery is stalled from the login or the last response", async () => {
    for (const [status, expected] of [
      [null, "undeliverable_login"],
      [401, "auth_paused"],
      [429, "rate_limited"],
      [503, "server_error"],
      [0, "backend_unreachable"],
    ]) {
      const store = await healthStore();
      const audit = store.open();
      await audit.appendLine({ client_row_id: randomUUID() });
      if (status !== null) await audit.drain(async () => ({ status, body: {} }), store);
      await audit.reportHealth(undefined, status === null ? {} : store);
      const events = (await store.open("health").readPending()).map(({ row }) => row);
      assert.equal(events.length, 1, expected);
      assert.equal(events[0].reason_code, expected);
      assert.equal(events[0].type, "queue_stalled");
      assert.equal(events[0].count, 1);
    }
  });

  it("retains a source receipt after a failed health append and never reports on health", async () => {
    const store = await healthStore();
    let fail = true;
    const audit = store.open("audit", {
      beforeCommit(point) {
        if (point === "append" && fail) throw new Error("disk full");
      },
    });
    fail = false;
    await audit.appendLine({ client_row_id: randomUUID(), metadata: "x".repeat(300_000) });
    fail = true;
    await assert.rejects(audit.reportHealth(undefined, store), /disk full/);
    await store.open().reportHealth(undefined, store);
    const health = store.open("health");
    assert.equal((await health.readPending())[0].row.reason_code, "oversize");
    await health.drain(
      async ({ rows }) => ({
        status: 200,
        body: {
          results: rows.map(({ event_id }) => ({ event_id, outcome: "rejected" })),
        },
      }),
      store
    );
    await health.reportHealth("backend_unreachable", store);
    assert.equal((await health.readDeadLetters()).length, 1);
    assert.deepEqual(await health.readPending(), []);
  });

  it("reports exhausted moves once after recovery without an eleventh send", async () => {
    const store = await healthStore();
    let fail = false;
    const audit = store.open("audit", {
      beforeCommit(point) {
        if (fail && point === "deadLetter") throw new Error("interrupted dead letter commit");
      },
    });
    await audit.appendLine({ client_row_id: randomUUID() });
    const offline = async () => ({ status: 409, body: { error: "conflict" } });
    for (let attempt = 0; attempt < 9; attempt++) {
      await audit.drain(offline, store);
      store.advance(1);
    }
    fail = true;
    await assert.rejects(audit.drain(offline, store), /interrupted/);
    const restarted = store.open();
    await restarted.drain(() => assert.fail("eleventh attempt"), store);
    await restarted.reportHealth(undefined, store);
    await restarted.reportHealth(undefined, store);
    const events = (await store.open("health").readPending()).map(({ row }) => row);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason_code, "attempts_exhausted");
    assert.equal(events[0].count, 1);
  });

  it("uses event outcomes and the 100 event cap while retaining missing or invalid replies", async () => {
    const store = await healthStore();
    const health = store.open("health");
    for (let i = 0; i < 101; i++) await health.appendLine(healthEvent());
    const batches = [];
    await health.drain(async ({ rows }) => {
      batches.push(rows.length);
      return {
        status: 200,
        body: {
          results: [
            { event_id: rows[0].event_id, outcome: "accepted" },
            ...(rows.length > 1 ? [{ event_id: rows[1].event_id, outcome: "rejected" }] : []),
          ],
        },
      };
    }, store);
    assert.deepEqual(batches, [100, 1]);
    assert.equal((await health.readPending()).length, 98);
    assert.equal((await health.readDeadLetters()).length, 1);
    store.advance(1);
    await health.drain(
      async ({ rows }) => ({
        status: 200,
        body: {
          results: [
            { event_id: rows[0].event_id, outcome: "accepted" },
            { event_id: randomUUID(), outcome: "accepted" },
          ],
        },
      }),
      store
    );
    assert.equal((await health.readPending()).length, 98);
    store.advance(1);
    await health.drain(delivered, store);
    assert.deepEqual(await health.readPending(), []);
  });
});

for (const stream of ["audit", "health", "runs"]) {
  describe(`${stream} transient and authentication recovery`, () => {
    const row = () =>
      stream === "audit"
        ? { client_row_id: randomUUID() }
        : stream === "health"
          ? healthEvent()
          : {
              run_id: randomUUID(),
              report_seq: 1,
              session_id: "session",
              started_at: "2026-11-15T00:00:00.000Z",
              tool_calls: 0,
              gated_tool_calls: 0,
              plan_ids: [],
            };
    const accepted = ({ rows }) => ({
      status: 200,
      body: { results: rows.map((value) => ({ ...value, outcome: "accepted" })) },
    });
    // regression: #0012
    it("holds org_required visibly without probing authentication or spending attempts", async () => {
      const store = await healthStore();
      const wal = store.open(stream);
      const value = row();
      await wal.appendLine(value);
      await wal.drain(async () => ({ status: 403, body: { error: "org_required" } }), store);
      const paused = await wal.status(store.resolveLogin);
      assert.equal(paused.held, "org_required");
      assert.equal(paused.authPaused, false);
      assert.equal(paused.undeliverable, 1);
      let sends = 1;
      for (const minutes of [5, 10, 20, 40, 60, 60]) {
        store.advance(minutes * 60_000 - 1);
        await store.open(stream).authenticationSucceeded(store.binding);
        await store.open(stream).drain(() => assert.fail("held endpoint sent again too early"), {
          ...store,
          probe: () => assert.fail("org_required is not an auth pause"),
        });
        store.advance(1);
        await store.open(stream).drain(() => {
          sends++;
          return { status: 403, body: { error: "org_required" } };
        }, store);
      }
      assert.equal(sends, 7);
      assert.deepEqual(
        (await wal.readPending()).map(({ row, attempts }) => [row, attempts]),
        [[value, 0]]
      );
      assert.deepEqual(await wal.readDeadLetters(), []);
      const text = await handleArmorPolicyCommand("/armor status", {
        dataDir: store.dataDir,
        runReportingEnabled: false,
      });
      const label =
        stream === "audit"
          ? "Audit delivery"
          : stream === "health"
            ? "Health reporting"
            : "Run reporting";
      assert.match(text, new RegExp(`${label} held: org_required`));
      store.advance(3_600_000);
      await store.open(stream).drain(() => {
        throw new Error("offline while held");
      }, store);
      assert.equal((await wal.status(store.resolveLogin)).held, "org_required");
      assert.equal((await wal.readPending())[0].attempts, 0);
      store.advance(3_600_000);
      await store.open(stream).drain(() => ({ status: 503, body: {} }), store);
      assert.equal((await wal.status(store.resolveLogin)).held, "org_required");
      assert.equal((await wal.readPending())[0].attempts, 0);
      store.advance(3_600_000);
      await store.open(stream).drain((batch) => ({ ...accepted(batch), status: 422 }), {
        ...store,
        probe: () => assert.fail("hold retried as auth"),
      });
      assert.deepEqual(await wal.readPending(), []);
      assert.equal((await wal.status(store.resolveLogin)).held, null);
      await wal.appendLine(row());
      await wal.drain(async () => ({ status: 403, body: { error: "org_required" } }), store);
      store.advance(300_000);
      let retried = false;
      await store.open(stream).drain(() => {
        retried = true;
        return { status: 403, body: { error: "org_required" } };
      }, store);
      assert.equal(retried, true, "a successful send resets the hold backoff");
      await store.open(stream).restoreLogin("new-login-revision");
      await wal.drain(async () => ({ status: 403, body: { error: "org_required" } }), store);
      store.advance(300_000);
      await wal.drain(accepted, store);
      assert.deepEqual(await wal.readPending(), []);
    });
    if (stream === "audit") return;
    // regression: #0012
    it("retains every row without charging through repeated transient failures", async () => {
      for (const failure of [503, 429, 408, "network", "retryable", "missing"]) {
        const store = await healthStore();
        const wal = store.open(stream);
        const value = row();
        await wal.appendLine(value);
        for (let n = 0; n < 12; n++) {
          await store.open(stream).drain(async () => {
            if (failure === "network") throw new Error("offline");
            return {
              status: typeof failure === "number" ? failure : 200,
              body: {
                results: failure === "retryable" ? [{ ...value, outcome: "retryable" }] : [],
              },
            };
          }, store);
          store.advance(1);
        }
        assert.deepEqual(
          (await wal.readPending()).map(({ row, attempts }) => [row, attempts]),
          [[value, 0]],
          String(failure)
        );
        assert.deepEqual(await wal.readDeadLetters(), []);
        await wal.drain(accepted, store);
        assert.deepEqual(await wal.readPending(), []);
      }
    });
    // regression: #0012
    it("persists a 401 pause and lifts it by an authenticated probe with the same login", async () => {
      const store = await healthStore();
      const wal = store.open(stream);
      await wal.appendLine(row());
      await wal.drain(async () => ({ status: 401, body: {} }), store);
      assert.equal((await wal.status(store.resolveLogin)).paused, true);
      await store.open(stream).drain(() => assert.fail("paused send"), {
        ...store,
        probe: () => assert.fail("early probe"),
      });
      store.advance(120_000);
      await store.open(stream).drain(() => assert.fail("failed probe send"), {
        ...store,
        probe: () => ({ status: 401 }),
      });
      store.advance(120_000);
      await store.open(stream).drain(accepted, {
        ...store,
        probe: ({ login }) => {
          assert.deepEqual(login, store.binding);
          return { status: 200 };
        },
      });
      assert.deepEqual(await wal.readPending(), []);
      assert.equal((await wal.status(store.resolveLogin)).paused, false);
    });
    // regression: #0012
    it("resumes only the exact credential after another authenticated call succeeds", async () => {
      const store = await healthStore();
      const config = {
        dataDir: store.dataDir,
        backendEndpoint: store.binding.backend,
        apiKey: "ak_test_authrecovery000000000000000",
        runReportingEnabled: true,
      };
      const binding = {
        backend: config.backendEndpoint,
        keyId: loginTag(config.backendEndpoint, config.apiKey),
      };
      const wal = store.open(stream, { login: binding.keyId, binding });
      await wal.appendLine(row());
      await wal.drain(async () => ({ status: 401, body: {} }), { resolveLogin: () => binding });
      await outbox.recordAuthenticationSuccess({ ...config, apiKey: "another-key" });
      assert.equal((await wal.status(() => binding)).paused, true);
      const other = path.join(store.dataDir, stream === "runs" ? "health" : "runs", binding.keyId);
      await mkdir(other, { recursive: true });
      await writeFile(path.join(other, "outbox-state.json"), "invalid state");
      await outbox.recordAuthenticationSuccess(config);
      await wal.drain(accepted, { resolveLogin: () => binding });
      assert.deepEqual(await wal.readPending(), []);
    });
    // regression: #0012
    it("keeps the pending row recoverable when a durable receipt cannot be written", async () => {
      const store = await healthStore();
      const wal = store.open(stream);
      const value = row();
      await wal.appendLine(value);
      const receipts = path.join(store.dataDir, stream, store.binding.keyId, "outbox-receipts");
      await writeFile(receipts, "unavailable receipt directory");
      await assert.rejects(wal.drain(accepted, store), /EEXIST|ENOTDIR/);
      assert.deepEqual(
        (await wal.readPending()).map(({ row }) => row),
        [value]
      );
      await rename(receipts, `${receipts}.saved`);
      await store
        .open(stream)
        .drain(() => assert.fail("a proven acceptance was sent again"), store);
      assert.deepEqual(await wal.readPending(), []);
    });

    // regression: #0012
    it("bounds recent settled identities while retaining durable archives", async () => {
      const store = await healthStore();
      const wal = store.open(stream, { rotateBytes: 1 });
      const first = row();
      await wal.appendLine(first);
      for (let n = 1; n < 520; n++) await wal.appendLine(row());
      await wal.drain(accepted, store);
      const state = JSON.parse(await readFile(wal._paths.offsetPath, "utf8"));
      assert.ok((state.eventsSettled ?? state.reportsSettled).length <= 512);
      assert.deepEqual(await wal.readPending(), []);
      assert.ok((await readdir(wal._paths.archiveDir)).some((name) => name.endsWith(".jsonl")));
      await store.open(stream).appendLine(first);
      assert.deepEqual(await wal.readPending(), []);
    });
  });
}

describe("runs outbox conformance", () => {
  const report = (run_id = "prompt-1", report_seq = 1) => ({
    run_id,
    report_seq,
    session_id: "session-1",
    started_at: "2026-11-15T00:00:00.000Z",
    tool_calls: 0,
    gated_tool_calls: 0,
    plan_ids: [],
  });
  const replies = (rows, outcome) => ({
    status: 200,
    body: { results: rows.map(({ run_id, report_seq }) => ({ run_id, report_seq, outcome })) },
  });

  it("settles start and final reports independently by run and sequence, including stale replies", async () => {
    const store = await healthStore();
    const runs = store.open("runs");
    await runs.appendLine(report());
    await runs.appendLine(report("prompt-1", 2));
    await runs.appendLine(report("prompt-2"));
    await runs.drain(
      async ({ rows }) => ({
        status: 200,
        body: {
          results: rows.slice(0, 2).map(({ run_id, report_seq }, i) => ({
            run_id,
            report_seq,
            outcome: i ? "stale" : "duplicate",
          })),
        },
      }),
      store
    );
    assert.deepEqual(
      (await runs.readPending()).map(({ row }) => row),
      [report("prompt-2")]
    );
    store.advance(1);
    await runs.drain(async ({ rows }) => replies(rows, "rejected"), store);
    assert.equal((await runs.readDeadLetters()).length, 1);
    assert.deepEqual(await runs.readPending(), []);
  });

  it("deduplicates durable handoffs across restart without mixing streams", async () => {
    const store = await healthStore();
    await store.open("runs").appendLine(report());
    await store.open("runs").appendLine(report());
    const restarted = store.open("runs");
    assert.equal((await restarted.readPending()).length, 1);
    await store.open("audit").appendLine({ client_row_id: randomUUID() });
    await restarted.drain(async ({ rows }) => replies(rows, "accepted"), store);
    await restarted.appendLine(report());
    assert.deepEqual(await restarted.readPending(), []);
    assert.equal((await store.open("audit").readPending()).length, 1);
  });

  it("pauses on logout, another login and a 404 without consuming attempts", async () => {
    const store = await healthStore();
    const runs = store.open("runs");
    await runs.appendLine(report());
    await runs.drain(() => assert.fail("logged out send"));
    await runs.drain(() => assert.fail("another login send"), {
      resolveLogin: () => ({ ...store.binding, keyId: "bbbbbbbbbbbbbbbb" }),
    });
    await runs.drain(async () => ({ status: 404, body: {} }), store);
    assert.equal((await store.open("runs").status(store.resolveLogin)).paused, true);
    assert.equal((await runs.readPending())[0].attempts, 0);
    await runs.drain(() => assert.fail("probe before its time"), store);
    store.advance(30_000);
    await runs.drain(async ({ rows }) => replies(rows, "accepted"), store);
    assert.equal((await runs.status(store.resolveLogin)).paused, false);
    assert.deepEqual(await runs.readPending(), []);
  });

  it("caps reports at 200 and retries malformed or missing composite outcomes", async () => {
    const store = await healthStore();
    const runs = store.open("runs");
    for (let n = 0; n < 201; n++) await runs.appendLine(report(`prompt-${n}`));
    const sizes = [];
    await runs.drain(async ({ rows }) => {
      sizes.push(rows.length);
      return {
        status: 200,
        body: { results: [{ run_id: rows[0].run_id, report_seq: 99, outcome: "accepted" }] },
      };
    }, store);
    assert.deepEqual(sizes, [200, 1]);
    assert.equal((await runs.readPending()).length, 201);
    store.advance(1);
    await runs.drain(async ({ rows }) => replies(rows, "accepted"), store);
    assert.deepEqual(await runs.readPending(), []);
  });
});
