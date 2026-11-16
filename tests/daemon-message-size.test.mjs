import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { daemonLogPath } from "../scripts/lib/daemon-log.mjs";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";

test("a PostToolUse with a 1 MB tool_response is served by the daemon and audits the same row as a small one", async (t) => {
  const backend = await startBackend();
  const { dataDir, hook } = await startHookSession(t, backend);

  for (const stdout of ["x".repeat(2001), "x".repeat(1_000_000)]) {
    await hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cat big.log" },
      tool_response: { stdout },
    });
  }
  await hook({ hook_event_name: "Stop" });

  await waitFor(() => backend.auditRows.length === 2, 15_000, "two audit rows at the backend");
  const [small, large] = backend.auditRows;
  assert.deepEqual(large.output, small.output);
  const log = daemonLogPath(dataDir);
  const fallbacks = existsSync(log) ? readFileSync(log, "utf8") : "";
  assert.doesNotMatch(fallbacks, /handling PostToolUse in-process/);
});
