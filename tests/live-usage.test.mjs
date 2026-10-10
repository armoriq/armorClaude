import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  alive,
  assistant,
  backend,
  env,
  GENERATION,
  home,
  isoAgo,
  liveFiles,
  projectFile,
  run,
  sessionBatches,
  settled,
  stop,
  stopDaemon,
  total,
  until,
  usageLine,
  withSession,
  writeSession,
} from "./helpers/live-usage.mjs";

const scanner = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "usage-sync.mjs"
);

for (const daemon of [false, true]) {
  const via = daemon ? "through the daemon" : "without the daemon";
  test(`a Stop posts its own session while the scanner is held on a backlog, ${via}`, async () => {
    const b = await backend();
    const h = home(b.url, isoAgo(3 * 3_600_000));
    try {
      for (let i = 0; i < 30; i++) {
        const id = randomUUID();
        writeSession(h, id, [
          assistant(id, `b${i}`, isoAgo(2 * 3_600_000 + i * 1000), {
            input_tokens: 3,
            output_tokens: 1,
          }),
        ]);
      }
      const scan = run(scanner, env(h, b.url, false));
      await until(() => b.singles.length > 0, "the scanner's first held post");
      const target = randomUUID();
      const at = isoAgo(60_000);
      const big = {
        input_tokens: 1000,
        output_tokens: 1000,
        cache_read_input_tokens: 40000,
        cache_creation_input_tokens: 8000,
      };
      const last = { ...big, output_tokens: 1790 };
      const messages = Array.from({ length: 8 }, (_, i) =>
        assistant(target, `m${i}`, at, i === 7 ? last : big)
      );
      writeSession(h, target, [...messages, ...messages, ...messages.slice(0, 7)]);
      await stop(h, b.url, daemon, target);
      await until(() => sessionBatches(b, target).length > 0, "the live session's batch");
      const hours = sessionBatches(b, target);
      assert.deepEqual(
        hours.map((s) => [s.usageDate, s.usageHour, total(s)]),
        [[at.slice(0, 10), Number(at.slice(11, 13)), 400_790]]
      );
      assert.equal(b.batches[0].generation, GENERATION);
      assert.equal(b.singles.length > 0 && !b.singles.some((s) => s.sessionId === target), true);
      b.release();
      await scan;
    } finally {
      b.release();
      await stopDaemon(h);
      b.server.closeAllConnections();
      await new Promise((r) => b.server.close(r));
      rmSync(h, { recursive: true, force: true });
    }
  });
}

test("a session that spans the login posts only the part after it, also after the ownership state is erased", async () => {
  const b = await backend();
  b.release();
  const loggedInAt = isoAgo(30 * 60_000);
  const h = home(b.url, loggedInAt);
  try {
    const id = randomUUID();
    const before = isoAgo(40 * 60_000);
    const after = isoAgo(20 * 60_000);
    writeSession(h, id, [
      assistant(id, "pre", before, { input_tokens: 10, output_tokens: 0 }),
      assistant(id, "post", after, { input_tokens: 20, output_tokens: 0 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length >= 1, "the first batch");
    assert.deepEqual(sessionBatches(b, id).map(total), [20]);
    rmSync(path.join(h, "data", "usage-sync-login.json"), { force: true });
    appendFileSync(
      projectFile(h, id),
      JSON.stringify(
        assistant(id, "late", isoAgo(10 * 60_000), { input_tokens: 5, output_tokens: 0 })
      ) + "\n"
    );
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length >= 2, "the second batch");
    const hourly = new Map();
    for (const s of sessionBatches(b, id)) hourly.set(`${s.usageDate}T${s.usageHour}`, s);
    const latest = [...hourly.values()];
    assert.equal(
      latest.reduce((n, s) => n + total(s), 0),
      25
    );
    assert.ok(sessionBatches(b, id).at(-1).revision > sessionBatches(b, id)[0].revision);
  } finally {
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
});

test("a Stop uploads nothing while the calling session turns usage off, and uploads once it is on", async () => {
  const b = await backend();
  b.release();
  const h = home(b.url, isoAgo(3_600_000));
  try {
    const id = randomUUID();
    writeSession(h, id, [
      assistant(id, "a", isoAgo(60_000), { input_tokens: 4, output_tokens: 0 }),
    ]);
    const offs = [
      { CLAUDE_PLUGIN_OPTION_DISABLE_USAGE_SYNC: "true" },
      { CLAUDE_PLUGIN_OPTION_DISABLE_OBSERVABILITY: "true" },
    ];
    for (const off of offs) await stop(h, b.url, true, id, off);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(sessionBatches(b, id).length, 0);
    await stop(h, b.url, true, id);
    await until(() => sessionBatches(b, id).length > 0, "the batch once usage is on");
    assert.deepEqual(sessionBatches(b, id).map(total), [4]);
  } finally {
    await stopDaemon(h);
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
});

test("the live upload keeps its state and log owner-only", async () => {
  const b = await backend();
  b.release();
  const h = home(b.url, isoAgo(3_600_000));
  try {
    const id = randomUUID();
    writeSession(h, id, [
      assistant(id, "a", isoAgo(60_000), { input_tokens: 4, output_tokens: 0 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length > 0, "the batch");
    const live = path.join(h, "data", "usage-live");
    const dir = () => path.join(live, readdirSync(live)[0]);
    await until(() => existsSync(path.join(dir(), `${id}.json`)), "the session state");
    const mode = (file) => statSync(file).mode & 0o777;
    assert.equal(mode(live), 0o700);
    assert.equal(mode(dir()), 0o700);
    for (const file of ["stream.json", `${id}.json`])
      assert.equal(mode(path.join(dir(), file)), 0o600, file);
    assert.equal(mode(path.join(h, "data", "usage-sync.log")), 0o600);
  } finally {
    b.server.closeAllConnections();
    await new Promise((r) => b.server.close(r));
    rmSync(h, { recursive: true, force: true });
  }
});

for (const loss of ["the upload is killed", "the response is lost"]) {
  test(`a batch the backend committed is sent again once with the same id and bytes when ${loss}`, async () => {
    await withSession(async (b, h, id) => {
      let held;
      b.onBatch = (res) => {
        b.onBatch = null;
        if (loss === "the response is lost") res.socket.destroy();
        else held = res;
        return true;
      };
      writeSession(h, id, [assistant(id, "a", isoAgo(60_000), { input_tokens: 7 })]);
      await stop(h, b.url, false, id);
      await until(() => b.batches.length === 1, "the first batch");
      if (held) {
        await until(() => existsSync(liveFiles(h, id).lock), "the upload's lock");
        const pid = Number(readFileSync(liveFiles(h, id).lock, "utf8"));
        process.kill(pid, "SIGKILL");
        await until(() => !alive(pid), "the killed upload to exit");
        held.socket.destroy();
        assert.equal(liveFiles(h, id).queued().length, 1);
      } else {
        assert.equal((await settled(h, id)).queued().length, 1);
      }
      appendFileSync(projectFile(h, id), usageLine(id, "b", isoAgo(30_000), { input_tokens: 3 }));
      await stop(h, b.url, false, id);
      await until(() => b.batches.length === 3, "the replay and the next capture");
      const files = await settled(h, id);
      assert.deepEqual(b.batches[1], b.batches[0]);
      assert.equal(b.batches.filter((x) => x.batchId === b.batches[0].batchId).length, 2);
      assert.ok(b.batches[2].snapshots[0].revision > b.batches[0].snapshots[0].revision);
      assert.deepEqual(b.batches[2].snapshots.map(total), [10]);
      assert.deepEqual(files.queued(), []);
    });
  });
}

test("a correction that moves tokens between categories posts although the total is the same", async () => {
  await withSession(async (b, h, id) => {
    const at = isoAgo(60_000);
    writeSession(h, id, [assistant(id, "a", at, { input_tokens: 100 })]);
    await stop(h, b.url, false, id);
    await until(() => b.batches.length === 1, "the first batch");
    await settled(h, id);
    writeSession(h, id, [
      assistant(id, "a", at, { input_tokens: 40, cache_read_input_tokens: 60 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => b.batches.length === 2, "the corrected batch");
    const [first, second] = b.batches.map((x) => x.snapshots[0]);
    assert.equal(total(first), total(second));
    assert.deepEqual([second.entries[0].inputTokens, second.entries[0].cacheReadTokens], [40, 60]);
  });
});

test("after the usage stream is reset every hour of the session is sent again under the new generation", async () => {
  await withSession(async (b, h, id) => {
    const earlier = isoAgo(2 * 3_600_000);
    writeSession(h, id, [
      assistant(id, "a", earlier, { input_tokens: 4 }),
      assistant(id, "b", isoAgo(60_000), { input_tokens: 6 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => b.batches.length === 1, "the first batch");
    await settled(h, id);
    b.generation = randomUUID();
    appendFileSync(projectFile(h, id), usageLine(id, "c", isoAgo(30_000), { input_tokens: 5 }));
    await stop(h, b.url, false, id);
    await until(() => b.batches.length === 2, "the batch under the new generation");
    const files = await settled(h, id);
    assert.equal(b.batches[1].generation, b.generation);
    assert.deepEqual(b.batches[1].snapshots.map(total).sort(), [11, 4].sort());
    assert.ok(b.batches[1].snapshots.some((s) => s.usageHour === Number(earlier.slice(11, 13))));
    assert.deepEqual(files.queued(), []);
  });
});

test("a batch the backend refuses for good is set aside with its reason and the next capture is sent", async () => {
  await withSession(async (b, h, id) => {
    let refusedId;
    b.onBatch = (res, body) => {
      refusedId ??= body.batchId;
      if (body.batchId !== refusedId) return false;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "usageHour must be a UTC hour" }));
      return true;
    };
    writeSession(h, id, [assistant(id, "a", isoAgo(60_000), { input_tokens: 7 })]);
    await stop(h, b.url, false, id);
    await until(() => b.batches.length === 1, "the refused batch");
    await settled(h, id);
    appendFileSync(projectFile(h, id), usageLine(id, "b", isoAgo(30_000), { input_tokens: 3 }));
    await stop(h, b.url, false, id);
    await until(() => b.batches.some((x) => x.batchId !== refusedId), "the next capture");
    const files = await settled(h, id);
    assert.equal(b.batches.filter((x) => x.batchId === refusedId).length, 1);
    assert.deepEqual(b.batches.at(-1).snapshots.map(total), [10]);
    assert.deepEqual(files.queued(), []);
    const [aside] = files.refused();
    assert.equal(aside.batch.batchId, refusedId);
    assert.deepEqual(aside.refused, { status: 400, reason: "usageHour must be a UTC hour" });
  });
});

test("a batch refused for good is retried hour by hour, only the refused hour is set aside, and it is sent again only once it changes", async () => {
  await withSession(async (b, h, id) => {
    const bad = isoAgo(2 * 3_600_000);
    const isBad = (s) =>
      s.usageDate === bad.slice(0, 10) && s.usageHour === Number(bad.slice(11, 13));
    b.onBatch = (res, body) => {
      if (!body.snapshots.some(isBad)) return false;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "usageHour must be a UTC hour" }));
      return true;
    };
    writeSession(h, id, [
      assistant(id, "a", bad, { input_tokens: 4 }),
      assistant(id, "b", isoAgo(60_000), { input_tokens: 6 }),
    ]);
    await stop(h, b.url, false, id);
    const alone = (x) => x.snapshots.length === 1 && !isBad(x.snapshots[0]);
    await until(() => b.batches.some(alone), "the good hour alone");
    const files = await settled(h, id);
    assert.deepEqual(
      files.refused().map((r) => r.batch.snapshots.map(total)),
      [[4]]
    );
    const sentBefore = b.batches.length;
    appendFileSync(projectFile(h, id), usageLine(id, "c", isoAgo(30_000), { input_tokens: 5 }));
    await stop(h, b.url, false, id);
    await until(() => b.batches.length > sentBefore, "the next capture");
    await settled(h, id);
    assert.deepEqual(
      b.batches
        .slice(sentBefore)
        .flatMap((x) => x.snapshots)
        .map(total),
      [11]
    );
    appendFileSync(projectFile(h, id), usageLine(id, "d", bad, { input_tokens: 2 }));
    await stop(h, b.url, false, id);
    await until(
      () => b.batches.slice(sentBefore + 1).some((x) => x.snapshots.some(isBad)),
      "the changed hour"
    );
    await settled(h, id);
  });
});
