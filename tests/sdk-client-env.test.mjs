import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../scripts/lib/config.mjs";
import { getSdkClient } from "../scripts/lib/intent.mjs";
import { STAGING, tempHome, withHome, writeLoginProfiles } from "./helpers/login-profile.mjs";

test("building an SDK client leaves ARMORIQ_ENV alone, so the next loadConfig keeps staging", () => {
  const saved = process.env.ARMORIQ_ENV;
  delete process.env.ARMORIQ_ENV;
  const home = writeLoginProfiles(tempHome(), [
    { backend: STAGING, apiKey: "ak_test_sdk_env_000000000000" },
  ]);
  try {
    withHome(home, () => {
      const config = loadConfig();
      assert.equal(config.backendEndpoint, STAGING);
      getSdkClient(config);
      assert.equal(process.env.ARMORIQ_ENV, undefined);
      assert.equal(loadConfig().backendEndpoint, STAGING);
    });
  } finally {
    if (saved === undefined) delete process.env.ARMORIQ_ENV;
    else process.env.ARMORIQ_ENV = saved;
  }
});
