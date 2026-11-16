import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import {
  assistant,
  env,
  hookRouter,
  isoAgo,
  projectFile,
  run,
  stopDaemon,
  until,
  withSession,
  writeSession,
} from "./helpers/live-usage.mjs";

const DEVICE_ID = "dev-latency-test";

function hook(h, url, daemon, event, sessionId) {
  writeFileSync(path.join(h, "device-id"), DEVICE_ID);
  return run(
    hookRouter,
    env(h, url, daemon),
    JSON.stringify({
      hook_event_name: event,
      session_id: sessionId,
      transcript_path: projectFile(h, sessionId),
      ...(event === "UserPromptSubmit" ? { prompt: "hi" } : {}),
    })
  );
}

const turnDuration = (sessionId, uuid, timestamp, durationMs, extra = {}) => ({
  type: "system",
  subtype: "turn_duration",
  sessionId,
  uuid,
  timestamp,
  durationMs,
  ...extra,
});

const settle = () => new Promise((r) => setTimeout(r, 1500));

for (const daemon of [false, true]) {
  const via = daemon ? "through the daemon" : "without the daemon";

  test(`a session without turn_duration lines posts the turns its prompt and Stop hooks timed, ${via}`, async () => {
    await withSession(async (b, h, id) => {
      try {
        writeSession(h, id, [
          assistant(id, "m1", isoAgo(60_000), { input_tokens: 1, output_tokens: 1 }),
        ]);
        assert.equal((await hook(h, b.url, daemon, "UserPromptSubmit", id)).code, 0);
        await new Promise((r) => setTimeout(r, 40));
        assert.equal((await hook(h, b.url, daemon, "Stop", id)).code, 0);
        await until(() => b.latency.length >= 1, "the first latency post");
        const [first] = b.latency;
        assert.equal(first.product, "armorclaude");
        assert.equal(first.sessionId, id);
        assert.equal(first.deviceId, DEVICE_ID);
        assert.equal(first.deviceName, hostname().trim().slice(0, 120));
        assert.equal(first.usageDate, new Date().toISOString().slice(0, 10));
        assert.equal(first.sampleCount, 1);
        assert.ok(first.totalMs >= 40, `turn took ${first.totalMs}ms`);
        assert.equal(
          first.buckets.reduce((a, n) => a + n, 0),
          1
        );

        await hook(h, b.url, daemon, "UserPromptSubmit", id);
        await hook(h, b.url, daemon, "Stop", id);
        await until(() => b.latency.length >= 2, "the second latency post");
        assert.equal(b.latency[1].sampleCount, 2);

        await hook(h, b.url, daemon, "Stop", id);
        await settle();
        assert.equal(b.latency.length, 2, "a Stop with no new turn posts nothing");
      } finally {
        await stopDaemon(h);
      }
    });
  });
}

test("a transcript's own turn_duration lines are posted instead of the hook times, from the login on", async () => {
  await withSession(async (b, h, id) => {
    writeSession(h, id, [
      turnDuration(id, "t-before", isoAgo(4 * 3_600_000), 9_000),
      turnDuration(id, "t-1", isoAgo(20 * 60_000), 1_200),
      turnDuration(id, "t-side", isoAgo(15 * 60_000), 70_000, { isSidechain: true }),
      turnDuration(id, "t-2", isoAgo(10 * 60_000), 45_000),
    ]);
    await hook(h, b.url, false, "UserPromptSubmit", id);
    await hook(h, b.url, false, "Stop", id);
    await until(() => b.latency.length >= 1, "the latency post");
    await settle();
    const sum = (key) => b.latency.reduce((n, p) => n + p[key], 0);
    assert.deepEqual([sum("sampleCount"), sum("totalMs")], [2, 46_200]);
    assert.equal(Math.max(...b.latency.map((p) => p.maxMs)), 45_000);
  });
});
