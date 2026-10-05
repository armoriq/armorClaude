import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const libDir = path.join(scriptsDir, "lib");
const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function localImports(file) {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(SPECIFIER)].map((m) => path.resolve(path.dirname(file), m[1]));
}

test("no module under scripts/lib is unreachable from a scripts/ entry point", () => {
  const entries = readdirSync(scriptsDir)
    .map((name) => path.join(scriptsDir, name))
    .filter((full) => statSync(full).isFile());
  const reached = new Set(entries);
  const queue = [...entries];
  while (queue.length > 0) {
    for (const target of localImports(queue.pop())) {
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  const unreachable = filesUnder(libDir)
    .filter((file) => !reached.has(file))
    .map((file) => path.relative(scriptsDir, file));
  assert.deepEqual(unreachable, []);
});
