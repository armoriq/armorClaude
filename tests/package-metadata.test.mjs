import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

test("release metadata uses @armoriq/sdk 0.6.3 from the npm registry", () => {
  const pkg = readJson("../package.json");
  const lock = readJson("../package-lock.json");
  const lockedSdk = lock.packages["node_modules/@armoriq/sdk"];

  assert.equal(pkg.dependencies["@armoriq/sdk"], "^0.6.3");
  assert.equal(lock.packages[""].dependencies["@armoriq/sdk"], "^0.6.3");
  assert.equal(lockedSdk.version, "0.6.3");
  assert.match(lockedSdk.resolved, /^https:\/\/registry\.npmjs\.org\//);
  assert.match(lockedSdk.integrity, /^sha512-/);
  assert.equal(lockedSdk.link, undefined);
  assert.equal(
    Object.keys(lock.packages).some((key) => key.includes("armoriq-sdk-customer-ts")),
    false,
  );
});
