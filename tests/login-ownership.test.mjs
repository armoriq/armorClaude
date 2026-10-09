import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loginOwnership,
  observeHistory,
  ownedOrUnassigned,
  ownerAt,
  validHistory,
} from "../scripts/lib/login-ownership.mjs";
import { syncUsage } from "../scripts/lib/usage-sync.mjs";

const T = (hhmm, day = "2026-10-09") => `${day}T${hhmm}:00.000Z`;
const ms = (iso) => Date.parse(iso);
const history = (events, { id = "h-1", origin = "fresh" } = {}) => ({
  id,
  origin,
  events: events.map(([at, userId], i) => ({ sequence: i + 1, at, userId })),
});
const anchorsOf = (h, observedAt = T("23:00")) => observeHistory(null, h, observedAt).anchors;

const S1 = "aaaaaaaa-0000-4000-8000-000000000001";
const S2 = "aaaaaaaa-0000-4000-8000-000000000002";
const msg = (id, timestamp, input, extra = {}) => ({
  type: "assistant",
  cwd: "/work/repo",
  ...(timestamp ? { timestamp } : {}),
  ...(id ? { requestId: `r-${id}` } : {}),
  message: {
    ...(id ? { id } : {}),
    model: "claude-opus",
    usage: { input_tokens: input, output_tokens: 0 },
  },
  ...extra,
});

function projects(files) {
  const root = mkdtempSync(path.join(tmpdir(), "ac-login-owner-"));
  assert.ok(root.startsWith(tmpdir()));
  for (const [rel, lines] of Object.entries(files)) {
    const full = path.join(root, "-work-repo", rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, lines.map((l) => JSON.stringify(l)).join("\n"));
  }
  return root;
}

async function postedFor(files, owns, state = { version: 2, sessions: {} }, post) {
  const rows = [];
  const report = await syncUsage({
    projectsDir: projects(files),
    state,
    owns,
    post: post ?? (async (row) => (rows.push(row), { ok: true })),
  });
  return {
    report,
    state,
    rows: rows.map((r) => [r.sessionId, r.usageDate, r.usageHour, r.entries[0].inputTokens]).sort(),
  };
}

const ownsFor = (anchors, user) => (t) => ownerAt(anchors, t) === user;
const AB = history([
  [T("09:00"), "A"],
  [T("10:37"), "B"],
]);

test("a history is valid only with consecutive sequences, canonical times, and users", () => {
  assert.equal(validHistory(AB), true);
  assert.equal(validHistory({ ...AB, origin: "reset" }), false);
  assert.equal(validHistory(history([["2026-10-09T10:00:00Z", "A"]])), false);
  assert.equal(validHistory({ ...AB, events: [{ ...AB.events[0], sequence: 2 }] }), false);
  assert.equal(validHistory(history([[T("10:00"), ""]])), false);
  assert.equal(validHistory({ id: "h-marker", origin: "unknown", events: [] }), false);
});

test("a fresh history gives the first user everything before their login, then each login its interval", () => {
  const a = anchorsOf(
    history([
      [T("09:00"), "A"],
      [T("10:37"), "B"],
      [T("11:05"), "A"],
    ])
  );
  assert.equal(ownerAt(a, ms("2026-09-01T00:00:00.000Z")), "A");
  assert.equal(ownerAt(a, ms(T("10:36"))), "A");
  assert.equal(ownerAt(a, ms(T("10:37"))), "B");
  assert.equal(ownerAt(a, ms(T("11:04"))), "B");
  assert.equal(ownerAt(a, ms(T("11:05"))), "A");
});

test("A -> B -> A with no sync while B was logged in still gives B its interval", () => {
  const before = anchorsOf(history([[T("09:00"), "A"]]), T("09:30"));
  const later = observeHistory(
    before,
    history([
      [T("09:00"), "A"],
      [T("10:37"), "B"],
      [T("11:05"), "A"],
    ]),
    T("11:30")
  );
  assert.equal(later.gap, false);
  assert.equal(ownerAt(later.anchors, ms(T("10:45"))), "B");
  assert.equal(ownerAt(later.anchors, ms(T("10:20"))), "A");
});

test("logout opens an unowned interval, and equal times follow event order", () => {
  const a = anchorsOf(
    history([
      [T("09:00"), "A"],
      [T("10:00"), null],
      [T("10:00"), "B"],
      [T("11:00"), null],
    ])
  );
  assert.equal(ownerAt(a, ms(T("09:59"))), "A");
  assert.equal(ownerAt(a, ms(T("10:00"))), "B");
  assert.equal(ownerAt(a, ms(T("11:30"))), null);
});

test("an unknown-origin history owns nothing before its first login", () => {
  const a = anchorsOf(history([[T("10:37"), "B"]], { origin: "unknown" }));
  assert.equal(ownerAt(a, ms(T("10:00"))), null);
  assert.equal(ownerAt(a, ms(T("10:40"))), "B");
});

test("a replaced, truncated or rewritten history is a gap: old intervals hold until last seen, the rest is unknown", () => {
  const seen = anchorsOf(
    history([
      [T("09:00"), "A"],
      [T("10:00"), "B"],
    ]),
    T("10:30")
  );
  const cases = {
    replaced: history([[T("12:00"), "B"]], { id: "h-2", origin: "fresh" }),
    truncated: history([[T("09:00"), "A"]]),
    rewritten: history([
      [T("09:00"), "A"],
      [T("10:00"), "C"],
      [T("12:00"), "B"],
    ]),
  };
  for (const [name, next] of Object.entries(cases)) {
    const { anchors, gap } = observeHistory(seen, next, T("12:30"));
    assert.equal(gap, true, name);
    assert.equal(anchors.current.origin, "unknown", name);
    assert.equal(ownerAt(anchors, ms(T("08:00"))), "A", name);
    assert.equal(ownerAt(anchors, ms(T("10:15"))), "B", name);
    assert.equal(ownerAt(anchors, ms(T("11:00"))), null, name);
  }
});

test("a second gap keeps the intervals the first gap proved", () => {
  const first = anchorsOf(history([[T("09:00"), "A"]]), T("12:00"));
  const second = observeHistory(
    first,
    history([[T("08:00"), "B"]], { id: "h-2", origin: "unknown" }),
    T("14:00")
  ).anchors;
  const third = observeHistory(
    second,
    history([[T("15:00"), "B"]], { id: "h-3", origin: "unknown" }),
    T("16:00")
  ).anchors;
  for (const anchors of [second, third]) {
    assert.equal(ownerAt(anchors, ms(T("10:00"))), "A");
    assert.equal(ownerAt(anchors, ms(T("13:00"))), null);
  }
  assert.equal(ownerAt(third, ms(T("15:30"))), "B");
});

test("a mid-hour login splits one session-hour by message time", async () => {
  const files = { [`${S1}.jsonl`]: [msg("a1", T("10:20"), 11), msg("b1", T("10:45"), 13)] };
  const a = anchorsOf(AB);
  assert.deepEqual((await postedFor(files, ownsFor(a, "B"))).rows, [[S1, "2026-10-09", 10, 13]]);
  assert.deepEqual((await postedFor(files, ownsFor(a, "A"))).rows, [[S1, "2026-10-09", 10, 11]]);
});

test("a delayed first sync still posts the new user's messages from their login on", async () => {
  const files = { [`${S2}.jsonl`]: [msg("b1", T("10:45"), 13), msg("b2", T("11:30"), 17)] };
  const { rows } = await postedFor(files, ownsFor(anchorsOf(AB, T("12:05")), "B"));
  assert.deepEqual(rows, [
    [S2, "2026-10-09", 10, 13],
    [S2, "2026-10-09", 11, 17],
  ]);
});

test("lines without a message id count zero before the login and keep their totals after it", async () => {
  const files = {
    [`${S1}.jsonl`]: [
      msg(null, T("10:20"), 11),
      msg(null, T("10:45"), 13),
      msg(null, T("10:50"), 2),
    ],
  };
  assert.deepEqual((await postedFor(files, ownsFor(anchorsOf(AB), "B"))).rows, [
    [S1, "2026-10-09", 10, 15],
  ]);
  assert.deepEqual((await postedFor(files, ownsFor(anchorsOf(AB), "A"))).rows, [
    [S1, "2026-10-09", 10, 11],
  ]);
});

test("a line without a timestamp takes the previous line's time, and subagent lines are filtered too", async () => {
  const files = {
    [`${S1}.jsonl`]: [
      msg("a1", T("10:20"), 11),
      msg("a2", null, 5),
      msg(null, null, 3),
      msg("b1", T("10:45"), 13),
    ],
    [`${S1}/subagents/agent-1.jsonl`]: [msg("s1", T("10:30"), 100), msg("s2", T("10:50"), 7)],
  };
  assert.deepEqual((await postedFor(files, ownsFor(anchorsOf(AB), "B"))).rows, [
    [S1, "2026-10-09", 10, 20],
  ]);
  assert.deepEqual((await postedFor(files, ownsFor(anchorsOf(AB), "A"))).rows, [
    [S1, "2026-10-09", 10, 119],
  ]);
});

test("a fork's copied messages stay out, and its own messages follow ownership", async () => {
  const original = [msg("a1", T("10:20"), 11)];
  const files = {
    [`${S1}.jsonl`]: original,
    [`${S2}.jsonl`]: [{ ...original[0], sessionId: S1 }, msg("b1", T("10:45"), 13)],
  };
  assert.deepEqual((await postedFor(files, ownsFor(anchorsOf(AB), "B"))).rows, [
    [S2, "2026-10-09", 10, 13],
  ]);
});

test("A's rows that failed before B logged in are posted when A syncs again", async () => {
  const anchors = anchorsOf(
    history([
      [T("09:00"), "A"],
      [T("10:37"), "B"],
      [T("11:05"), "A"],
    ])
  );
  const files = {
    [`${S1}.jsonl`]: [msg("a1", T("09:10"), 7)],
    [`${S2}.jsonl`]: [msg("b1", T("10:45"), 13)],
  };
  const state = { version: 2, sessions: {} };
  const failed = await postedFor(files, ownsFor(anchors, "A"), state, async () => ({
    ok: false,
    status: 503,
    reason: "down",
  }));
  assert.equal(failed.report.failed, 1);
  const again = await postedFor(files, ownsFor(anchors, "A"), state);
  assert.deepEqual(again.rows, [[S1, "2026-10-09", 9, 7]]);
});

test("a rotated key for the same user keeps the interval", () => {
  const rotated = anchorsOf(
    history([
      [T("09:00"), "A"],
      [T("10:00"), "A"],
    ])
  );
  assert.equal(ownerAt(rotated, ms(T("09:30"))), "A");
  assert.equal(ownerAt(rotated, ms(T("10:30"))), "A");
});

test("a dashboard history request claims unassigned time and its own, never another user's", async () => {
  const seen = anchorsOf(history([[T("09:00"), "A"]]), T("09:30"));
  const { anchors } = observeHistory(
    seen,
    history([[T("11:00"), "B"]], { id: "h-2", origin: "unknown" }),
    T("11:30")
  );
  const claims = ownedOrUnassigned(anchors, "B");
  assert.equal(claims(ms(T("09:10"))), false, "A's proven interval");
  assert.equal(claims(ms(T("10:00"))), true, "unknown, after A was last seen");
  assert.equal(claims(ms(T("11:10"))), true, "B's own");
  const loggedOut = anchorsOf(
    history([
      [T("09:00"), "A"],
      [T("10:00"), null],
      [T("11:00"), "B"],
    ])
  );
  assert.equal(ownedOrUnassigned(loggedOut, "B")(ms(T("10:30"))), true, "logged out");
  assert.equal(ownedOrUnassigned(loggedOut, "B")(ms(T("09:30"))), false, "A's interval");
  const files = {
    [`${S1}.jsonl`]: [
      msg("a1", T("09:10"), 11),
      msg("u1", T("10:00"), 13),
      msg("b1", T("11:10"), 2),
    ],
  };
  assert.deepEqual((await postedFor(files, claims)).rows, [
    [S1, "2026-10-09", 10, 13],
    [S1, "2026-10-09", 11, 2],
  ]);
});

const rolledBack = (origin = "fresh") =>
  history(
    [
      [T("10:30"), "A"],
      [T("10:10"), "B"],
    ],
    { origin }
  );
const rollbackFiles = {
  [`${S1}.jsonl`]: [
    msg("a1", T("09:10"), 7),
    msg("x1", T("10:20"), 11),
    msg("b1", T("10:45"), 13),
    msg("b2", T("11:30"), 17),
  ],
};

test("a login whose time is earlier than the one before it is accepted in sequence order", () => {
  assert.equal(validHistory(rolledBack()), true);
});

test("after a clock rollback, usage in the overlap is posted for neither user and never claimed", async () => {
  const anchors = anchorsOf(rolledBack());
  const asA = [[S1, "2026-10-09", 9, 7]];
  const asB = [
    [S1, "2026-10-09", 10, 13],
    [S1, "2026-10-09", 11, 17],
  ];
  assert.deepEqual((await postedFor(rollbackFiles, ownsFor(anchors, "A"))).rows, asA);
  assert.deepEqual((await postedFor(rollbackFiles, ownsFor(anchors, "B"))).rows, asB);
  assert.deepEqual((await postedFor(rollbackFiles, ownedOrUnassigned(anchors, "A"))).rows, asA);
  assert.deepEqual((await postedFor(rollbackFiles, ownedOrUnassigned(anchors, "B"))).rows, asB);
});

test("an overlap inside an archived history stays unclaimed after a gap", async () => {
  const seen = anchorsOf(rolledBack("unknown"), T("11:00"));
  const { anchors } = observeHistory(
    seen,
    history([[T("11:10"), "C"]], { id: "h-2", origin: "unknown" }),
    T("11:40")
  );
  assert.deepEqual((await postedFor(rollbackFiles, ownedOrUnassigned(anchors, "C"))).rows, [
    [S1, "2026-10-09", 11, 17],
    [S1, "2026-10-09", 9, 7],
  ]);
});

const rollbackCases = {
  unknown: {
    A: [[11, 36]],
    B: [[10, 24]],
    claimedByA: [
      [11, 36],
      [9, 5],
    ],
    claimedByB: [
      [10, 24],
      [9, 5],
    ],
  },
  fresh: {
    A: [
      [11, 36],
      [9, 5],
    ],
    B: [[10, 24]],
    claimedByA: [
      [11, 36],
      [9, 5],
    ],
    claimedByB: [[10, 24]],
  },
};

for (const [origin, expected] of Object.entries(rollbackCases)) {
  test(`the shared ${origin}-origin clock-rollback history: overlap usage is posted for no one and nothing counts twice`, async () => {
    const fixture = new URL(`./fixtures/login-clock-rollback-${origin}.json`, import.meta.url);
    const anchors = anchorsOf(JSON.parse(readFileSync(fixture)));
    const at = (time) => `2026-10-09T${time}Z`;
    const files = {
      [`${S1}.jsonl`]: [
        msg("m1", at("09:00:00.000"), 5),
        msg("m2", at("09:55:00.000"), 7),
        msg("m3", at("10:37:12.344"), 11),
        msg("m4", at("10:59:59.999"), 13),
        msg("m5", at("11:05:00.000"), 17),
        msg("m6", at("11:30:00.000"), 19),
      ],
    };
    const rows = (hours) => hours.map(([hour, tokens]) => [S1, "2026-10-09", hour, tokens]);
    assert.deepEqual((await postedFor(files, ownsFor(anchors, "A"))).rows, rows(expected.A));
    assert.deepEqual((await postedFor(files, ownsFor(anchors, "B"))).rows, rows(expected.B));
    assert.deepEqual(
      (await postedFor(files, ownedOrUnassigned(anchors, "A"))).rows,
      rows(expected.claimedByA)
    );
    assert.deepEqual(
      (await postedFor(files, ownedOrUnassigned(anchors, "B"))).rows,
      rows(expected.claimedByB)
    );
  });
}

test("a refused login history logs its cause and the command that fixes it", async () => {
  const UNUSABLE =
    "this login has no usable login history, nothing synced. Run: armoriq-dev login --product armorclaude --force";
  const NOT_OWNER =
    "the latest login in the history isn't this key's owner, nothing synced. Run: armoriq-dev login --product armorclaude --force";
  const h = history([[T("09:00"), "user-a"]]);
  const config = {
    loginHistory: h,
    userId: "user-a",
    loggedInAt: T("09:00"),
    dataDir: mkdtempSync(path.join(tmpdir(), "ac-own-")),
  };
  const cases = [
    [{ ...config, loginHistory: { ...h, events: [] } }, "user-a", UNUSABLE],
    [{ ...config, userId: "user-b" }, "user-b", NOT_OWNER],
    [{ ...config, loggedInAt: T("09:30") }, "user-a", NOT_OWNER],
    [config, "user-b", NOT_OWNER],
  ];
  for (const [cfg, userId, expected] of cases) {
    const logged = [];
    const owned = await loginOwnership({ config: cfg, userId, log: (m) => logged.push(m) });
    assert.equal(owned, null);
    assert.deepEqual(logged, [expected]);
  }
  const logged = [];
  const owned = await loginOwnership({ config, userId: "user-a", log: (m) => logged.push(m) });
  assert.equal(typeof owned, "function");
  assert.deepEqual(logged, []);
});
