import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../scripts/lib/config.mjs";
import { applyReach } from "../scripts/lib/reach.mjs";
import {
  PRODUCTION,
  STAGING,
  tempHome,
  withHome,
  writeLoginProfiles,
} from "./helpers/login-profile.mjs";

for (const [backend, expected] of [
  [PRODUCTION, true],
  [STAGING, false],
]) {
  test(`the reminder reads the existing main credential for ${backend}`, (t) => {
    const home = tempHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeLoginProfiles(home, [{ backend, apiKey: "ak_live_existing" }]);
    const config = withHome(home, () =>
      loadConfig({ ARMORIQ_ENV: "production", DO_NOT_TRACK: "1" })
    );
    assert.equal(config.unconfigured, !expected);
    assert.equal(Boolean(applyReach("SessionStart", {}, config, null, { home })), !expected);
  });
}

for (const unreadable of [false, true]) {
  test(`a ${unreadable ? "unreadable" : "malformed"} credential file suppresses the reminder`, (t) => {
    const home = tempHome();
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(path.join(home, ".armoriq"));
    const file = path.join(home, ".armoriq/credentials.json");
    writeFileSync(file, unreadable ? "{}" : "{");
    if (unreadable) chmodSync(file, 0);
    const config = withHome(home, () => loadConfig({ DO_NOT_TRACK: "1" }));
    assert.equal(config.signInReminderEnabled, false);
    assert.equal(applyReach("SessionStart", {}, config, null, { home }), null);
  });
}
