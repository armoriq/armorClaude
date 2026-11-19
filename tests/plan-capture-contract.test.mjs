import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../scripts/lib/config.mjs";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/plan-capture-v1.json", import.meta.url))
);

for (const [group, symbol, input] of [
  ["canonicalJson", "canonicalJson", "input"],
  ["planHash", "planHash", "plan"],
  ["idempotencyKey", "idempotencyKey", "input"],
]) {
  test(`all ${group} fixture vectors`, async () => {
    const contract = await import("../scripts/lib/plan-request.mjs");
    for (const vector of fixtures[group]) {
      assert.equal(contract[symbol](vector[input]), vector.expected, vector.name);
      if (group === "idempotencyKey" && vector.input.kind === "refresh")
        assert.equal(
          contract.idempotencyKey({ ...vector.input, epoch: 2 }),
          vector.expected,
          vector.name
        );
    }
  });
}

test("shared validity takes precedence and invalid values stop configuration", () => {
  for (const value of ["180", "3600", "240"]) {
    assert.equal(
      loadConfig({
        ARMORIQ_INTENT_VALIDITY_SECONDS: value,
      }).validitySeconds,
      Number(value)
    );
  }
  assert.equal(loadConfig({}).validitySeconds, 3600);
  for (const value of ["", "bad", "179", "3601", "Infinity", "180.5"]) {
    assert.throws(
      () => loadConfig({ ARMORIQ_INTENT_VALIDITY_SECONDS: value }),
      /ARMORIQ_INTENT_VALIDITY_SECONDS/
    );
  }
});
