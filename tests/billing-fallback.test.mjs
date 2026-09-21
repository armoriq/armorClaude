import { test } from "node:test";
import assert from "node:assert/strict";
import { allowWithNotice, isBillingError, denyPreTool } from "../scripts/lib/hook-output.mjs";

test("isBillingError matches the backend 402 subscription messages", () => {
  // Exact strings from conmap-auto/src/billing/quota.service.ts
  assert.equal(
    isBillingError("An active ArmorIQ Pro subscription is required to use armorclaude."),
    true
  );
  assert.equal(
    isBillingError("This API key has no organization, so billing cannot be verified."),
    true
  );
  assert.equal(isBillingError("Request failed with status code 402"), true);
});

test("isBillingError does NOT swallow real enforcement / network errors", () => {
  assert.equal(isBillingError("intent drift: tool not in plan"), false);
  assert.equal(isBillingError("ECONNREFUSED 127.0.0.1:8000"), false);
  assert.equal(isBillingError("Invalid or expired API key"), false);
  assert.equal(isBillingError(""), false);
  assert.equal(isBillingError(undefined), false);
});

test("allowWithNotice steps aside (no permissionDecision) and surfaces the nudge", () => {
  const out = allowWithNotice("upgrade at https://tools.armoriq.ai/tools/billing");
  // Must NOT force allow/deny — Claude Code's own permission flow proceeds.
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  // The user-visible message is present.
  assert.match(out.systemMessage, /upgrade/i);
});

test("regression: denyPreTool still hard-denies (non-billing path unchanged)", () => {
  const out = denyPreTool("intent drift");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
});
