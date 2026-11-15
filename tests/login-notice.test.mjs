import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rmSync } from "node:fs";
import { loadConfig, loginCommand } from "../scripts/lib/config.mjs";
import { handleSessionStart } from "../scripts/lib/engine.mjs";
import { withReloginNotice } from "../scripts/lib/relogin.mjs";
import {
  PRODUCTION,
  STAGING,
  tempHome,
  withHome,
  writeLoginProfiles,
} from "./helpers/login-profile.mjs";

for (const [what, entries] of [
  ["no login", []],
  [
    "only an armorcodex login",
    [{ backend: STAGING, product: "armorcodex", apiKey: "ak_test_other" }],
  ],
  ["a login for another backend", [{ backend: PRODUCTION, apiKey: "ak_live_other" }]],
]) {
  test(`${what} shows the reminder once per day and keeps the monitor context`, async (t) => {
    const home = tempHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeLoginProfiles(home, entries);
    const config = withHome(home, () =>
      loadConfig({
        CLAUDE_PLUGIN_DATA: path.join(home, "data"),
        ARMORIQ_ENV: "staging",
        DO_NOT_TRACK: "1",
      })
    );
    const runs = [];
    for (const session_id of ["s-1", "s-1", "s-2"]) {
      const input = { session_id, hook_event_name: "SessionStart" };
      const output = await handleSessionStart(input, config);
      runs.push(
        await withHome(home, () => withReloginNotice("SessionStart", input, config, output))
      );
    }
    assert.deepEqual(
      runs.map((r) => r.systemMessage),
      [
        `ArmorClaude is not signed in to ArmorIQ. Sign in to see your plans and blocks on your dashboard: ${loginCommand(STAGING)} (hide this reminder: ARMORIQ_SIGNIN_REMINDER_DISABLED=1)`,
        undefined,
        undefined,
      ]
    );
    for (const output of runs) {
      const context = output.hookSpecificOutput.additionalContext;
      assert.match(context, /installed but NOT connected/);
      assert.match(context, /MONITOR/);
      assert.equal(context, runs[0].hookSpecificOutput.additionalContext);
      assert.equal(context.includes("ArmorClaude is not signed in"), false);
    }
  });
}
