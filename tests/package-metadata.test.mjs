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
  assert.equal(
    lockedSdk.integrity,
    "sha512-I/YjZrnOsbN4Yg3ZujEX91descHOf6K1Z1Kg2KfuTi019VPQaGfSdrda2Hx1VqLWxysw8UJil9BxZKRIVLHMrg==",
  );
  assert.equal(lockedSdk.link, undefined);
  assert.equal(
    Object.keys(lock.packages).some((key) => key.includes("armoriq-sdk-customer-ts")),
    false,
  );
});

test("release installer uses the production SDK and dashboard", () => {
  const installer = readFileSync(
    new URL("../install_armorclaude.sh", import.meta.url),
    "utf8",
  );

  assert.match(installer, /https:\/\/tools\.armoriq\.ai/);
  assert.match(installer, /npm install -g @armoriq\/sdk@latest/);
  assert.match(installer, /npx @armoriq\/sdk login/);
  assert.doesNotMatch(installer, /@armoriq\/sdk-dev/);
  assert.doesNotMatch(installer, /https:\/\/dev\.armoriq\.ai/);
});
