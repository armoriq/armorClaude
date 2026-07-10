import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../scripts/lib/config.mjs";

test("observabilityEnabled true when daemon on + api key present", () => {
  const cfg = loadConfig({
    ARMORIQ_ENV: "local",
    ARMORIQ_BACKEND_URL: "http://localhost:8080",
    ARMORIQ_API_KEY: "ak_live_test0000000000000000000000000000",
  });
  assert.equal(cfg.observabilityEnabled, true);
  assert.equal(cfg.observabilityEndpoint, "http://localhost:8080");
  assert.equal(cfg.observabilityProduct, "armorclaude");
});
