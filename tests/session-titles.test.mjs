import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assistant,
  env,
  isoAgo,
  projectFile,
  run,
  settled,
  stop,
  until,
  usageLine,
  withSession,
  writeSession,
} from "./helpers/live-usage.mjs";

const worker = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "usage-worker.mjs"
);

const titleLine = (sessionId, customTitle) => ({ type: "custom-title", customTitle, sessionId });
const appendTitle = (h, id, title) =>
  appendFileSync(projectFile(h, id), `${JSON.stringify(titleLine(id, title))}\n`);
const titlesOf = (b, id) =>
  b.batches.flatMap((x) => x.sessions ?? []).filter((s) => s.sessionId === id);
const titled = (b, id) =>
  b.batches.filter((x) => (x.sessions ?? []).some((s) => s.sessionId === id));

test("a Stop sends the session's title once, timed when the plugin first saw it, and again after a rename", async () => {
  await withSession(async (b, h, id) => {
    writeSession(h, id, [
      assistant(id, "a", isoAgo(60_000), { input_tokens: 3 }),
      titleLine(id, "Fix the parser"),
    ]);
    const before = Date.now();
    await stop(h, b.url, false, id);
    await until(() => titlesOf(b, id).length === 1, "the title");
    await settled(h, id);
    const [first] = titlesOf(b, id);
    assert.equal(first.title, "Fix the parser");
    assert.equal(first.titleSource, "claude-custom-title");
    assert.match(first.titleUpdatedAt, /Z$/);
    const seenAt = Date.parse(first.titleUpdatedAt);
    assert.ok(seenAt >= before && seenAt <= Date.now(), first.titleUpdatedAt);

    appendFileSync(projectFile(h, id), usageLine(id, "b", isoAgo(30_000), { input_tokens: 4 }));
    const batchesBefore = b.batches.length;
    await stop(h, b.url, false, id);
    await until(() => b.batches.length > batchesBefore, "the next usage batch");
    await settled(h, id);
    assert.equal(titlesOf(b, id).length, 1, "an unchanged title is not sent again");

    appendTitle(h, id, "Fix the lexer");
    await stop(h, b.url, false, id);
    await until(() => titlesOf(b, id).length === 2, "the renamed title");
    const [, renamed] = titlesOf(b, id);
    assert.equal(renamed.title, "Fix the lexer");
    assert.ok(Date.parse(renamed.titleUpdatedAt) > seenAt);
    assert.deepEqual(titled(b, id).at(-1).snapshots, [], "a rename alone sends no usage");
  });
});

test("a title over 200 characters is cut to 200 without splitting a character", async () => {
  await withSession(async (b, h, id) => {
    writeSession(h, id, [
      assistant(id, "a", isoAgo(60_000), { input_tokens: 3 }),
      titleLine(id, `${"x".repeat(199)}😀 and the rest of a long title`),
    ]);
    await stop(h, b.url, false, id);
    await until(() => titlesOf(b, id).length === 1, "the title");
    assert.equal(titlesOf(b, id)[0].title, "x".repeat(199));
  });
});

test("a title whose upload failed keeps its first-seen time when it is sent again", async () => {
  await withSession(async (b, h, id) => {
    b.onBatch = (res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "busy" }));
      return true;
    };
    writeSession(h, id, [
      assistant(id, "a", isoAgo(60_000), { input_tokens: 3 }),
      titleLine(id, "Fix the parser"),
    ]);
    await stop(h, b.url, false, id);
    await until(() => b.batches.length > 0, "the refused upload");
    await settled(h, id);
    const firstStopDone = Date.now();
    b.onBatch = null;
    await new Promise((r) => setTimeout(r, 20));
    appendFileSync(projectFile(h, id), usageLine(id, "b", isoAgo(30_000), { input_tokens: 4 }));
    await stop(h, b.url, false, id);
    await until(() => titlesOf(b, id).length > 0, "the title");
    await settled(h, id);
    const titles = titlesOf(b, id);
    assert.equal(titles.length, 1, "the queued title is sent once, not captured again");
    assert.ok(Date.parse(titles[0].titleUpdatedAt) <= firstStopDone, titles[0].titleUpdatedAt);
  });
});

test("the usage worker sends the titles of the sessions it scans", async () => {
  await withSession(async (b, h, id) => {
    writeSession(h, id, [
      assistant(id, "a", isoAgo(60_000), { input_tokens: 3 }),
      titleLine(id, "Scanned session"),
    ]);
    const { code } = await run(worker, env(h, b.url, false));
    assert.equal(code, 0);
    assert.deepEqual(
      titlesOf(b, id).map((s) => s.title),
      ["Scanned session"]
    );
  });
});
