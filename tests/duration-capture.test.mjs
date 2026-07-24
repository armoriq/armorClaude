/* eslint-disable */
import test from "node:test";
import assert from "node:assert/strict";
import {
  _recordToolStart,
  _computeToolDuration,
  _clearToolStartTimes,
} from "../scripts/lib/engine.mjs";

// Clean up between tests
test.beforeEach(() => {
  _clearToolStartTimes();
});

test("Pre->Post round-trip yields positive duration", async () => {
  const input = {
    tool_use_id: "tu-001",
    session_id: "sess-1",
    tool_name: "Bash",
  };

  _recordToolStart(input);

  // Simulate some elapsed time
  await new Promise((r) => setTimeout(r, 20));

  const duration = _computeToolDuration(input);
  assert.ok(typeof duration === "number", "duration should be a number");
  assert.ok(duration >= 10, `duration should be >= 10ms, got ${duration}`);
});

test("Concurrent tool_use_ids don't collide", () => {
  const inputA = {
    tool_use_id: "tu-aaa",
    session_id: "sess-1",
    tool_name: "Read",
  };
  const inputB = {
    tool_use_id: "tu-bbb",
    session_id: "sess-1",
    tool_name: "Read",
  };

  _recordToolStart(inputA);
  _recordToolStart(inputB);

  // Compute B first — should only consume B's entry
  const durationB = _computeToolDuration(inputB);
  assert.ok(typeof durationB === "number", "durationB should be a number");

  // A's entry should still be present
  const durationA = _computeToolDuration(inputA);
  assert.ok(typeof durationA === "number", "durationA should be a number");

  // Both consumed — second lookup on A should yield null
  const durationA2 = _computeToolDuration(inputA);
  assert.equal(durationA2, null, "second lookup should return null");
});

test("Missing start timestamp yields null, not 0", () => {
  const input = {
    tool_use_id: "tu-never-started",
    session_id: "sess-1",
    tool_name: "Bash",
  };

  const duration = _computeToolDuration(input);
  assert.equal(duration, null, "duration should be null when no start was recorded");
});

test("Failure path captures duration too", async () => {
  const input = {
    tool_use_id: "tu-fail-001",
    session_id: "sess-1",
    tool_name: "Bash",
  };

  _recordToolStart(input);
  await new Promise((r) => setTimeout(r, 10));

  // _computeToolDuration is agnostic to success/failure — it just computes
  // elapsed time. The failure path in handlePostToolUseFailure calls it the
  // same way as the success path.
  const duration = _computeToolDuration(input);
  assert.ok(typeof duration === "number", "duration should be a number");
  assert.ok(duration >= 5, `duration should be >= 5ms, got ${duration}`);
});

test("Deny in pre-hook still records start timestamp", () => {
  // _recordToolStart is called BEFORE any deny/early-return in handlePreToolUse.
  // This test verifies the function stores the start time regardless.
  const input = {
    tool_use_id: "tu-denied-001",
    session_id: "sess-1",
    tool_name: "Write",
  };

  _recordToolStart(input);

  // The start time should be available for later retrieval
  const duration = _computeToolDuration(input);
  assert.ok(typeof duration === "number", "duration should be a number even for denied calls");
  assert.ok(duration >= 0, "duration should be non-negative");
});

test("Fallback key when tool_use_id is missing", () => {
  const input = {
    session_id: "sess-99",
    tool_name: "Edit",
  };

  _recordToolStart(input);
  const duration = _computeToolDuration(input);
  assert.ok(typeof duration === "number", "should work with fallback key");
  assert.ok(duration >= 0);
});

test("Fallback key when tool_use_id is empty string", () => {
  const input = {
    tool_use_id: "",
    session_id: "sess-99",
    tool_name: "Edit",
  };

  _recordToolStart(input);
  const duration = _computeToolDuration(input);
  assert.ok(typeof duration === "number", "should work with empty tool_use_id fallback");
});
