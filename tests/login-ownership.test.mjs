import { test } from "node:test";
import assert from "node:assert/strict";
import { validHistory } from "../scripts/lib/login-ownership.mjs";

const T = (hhmm, day = "2026-10-09") => `${day}T${hhmm}:00.000Z`;
const history = (events, { id = "h-1", origin = "fresh" } = {}) => ({
  id,
  origin,
  events: events.map(([at, userId], i) => ({ sequence: i + 1, at, userId })),
});
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
