import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as engine from "../scripts/lib/engine.mjs";

test("every hook-router handler name is a function exported by engine.mjs", async () => {
  const src = await readFile(new URL("../scripts/hook-router.mjs", import.meta.url), "utf8");
  const block = src.match(/const HANDLERS = \{([^}]*)\}/)?.[1];
  assert.ok(block, "HANDLERS table not found in hook-router.mjs");
  const names = [...block.matchAll(/:\s*"(\w+)"/g)].map(([, name]) => name);
  assert.ok(names.length >= 8, `found only ${names.length} handlers`);
  for (const name of names) assert.equal(typeof engine[name], "function", name);
});
