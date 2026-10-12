import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startBackend, startHookSession } from "./helpers/hook-session.mjs";

test("the intent token request carries the Claude session id as its context", async (t) => {
  const backend = await startBackend({
    "POST /iap/sdk/token": () => [
      200,
      {
        success: true,
        plan_id: randomUUID(),
        plan_hash: "plan-hash",
        intent_reference: "intent-ref",
        token: { issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
        step_proofs: [],
      },
    ],
  });
  const { sessionId, hook } = await startHookSession(t, backend);
  await hook({ hook_event_name: "SessionStart", source: "startup" });
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "list the files" });
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  const requests = backend.requests.filter((r) => r.route === "POST /iap/sdk/token");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.context_id, sessionId);
});
