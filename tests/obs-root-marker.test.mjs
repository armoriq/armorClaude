import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimRootStart } from "../scripts/lib/obs-root-marker.mjs";

const corrupt = ["2026-10-01T09:00Z", '{"startTime":"2026', "", '{"pid":1}', '{"startTime":0}'];

test("processes that find an unreadable marker converge on one start time, in private files", async () => {
  const writtenAt = new Date("2026-10-04T08:00:00.000Z");
  for (const content of corrupt) {
    const dataDir = mkdtempSync(path.join(tmpdir(), "obs-corrupt-"));
    await claimRootStart(dataDir, "sess-corrupt");
    const dir = path.join(dataDir, "obs-roots");
    const marker = path.join(dir, readdirSync(dir)[0]);
    writeFileSync(marker, content);
    utimesSync(marker, writtenAt, writtenAt);

    const starts = await Promise.all([1, 2, 3].map(() => claimRootStart(dataDir, "sess-corrupt")));

    assert.deepEqual(starts, [writtenAt, writtenAt, writtenAt], content);
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { startTime: writtenAt.toJSON() });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(marker).mode & 0o777, 0o600, content);
    assert.deepEqual(readdirSync(dir), [path.basename(marker)], content);
  }
});

test("claiming a root start never throws", async () => {
  const dataDir = path.join(mkdtempSync(path.join(tmpdir(), "obs-nodir-")), "file");
  writeFileSync(dataDir, "not a directory");
  assert.equal(await claimRootStart(dataDir, "sess-nodir"), null);
});

test("the first new marker in a process prunes week-old markers and minute-old drafts", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "obs-prune-"));
  const dir = path.join(dataDir, "obs-roots");
  mkdirSync(dir, { mode: 0o700 });
  const ages = { stale: 8 * 1440, fresh: 6 * 1440, "stale.draft": 2, "fresh.draft": 0.5 };
  for (const [name, minutes] of Object.entries(ages)) {
    writeFileSync(path.join(dir, name), "{}");
    const at = new Date(Date.now() - minutes * 60_000);
    utimesSync(path.join(dir, name), at, at);
  }
  await claimRootStart(dataDir, "sess-new");

  const left = readdirSync(dir);
  assert.equal(left.length, 3, left.join());
  assert.deepEqual(left.filter((name) => name in ages).sort(), ["fresh", "fresh.draft"]);
});
