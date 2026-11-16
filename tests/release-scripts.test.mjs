import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const versionScript = path.join(repo, "scripts", "release-version.mjs");
const notesScript = path.join(repo, "scripts", "release-notes.mjs");
const FILES = [
  "package.json",
  "package-lock.json",
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

const CHANGELOG = `# Changelog

Intro.

## [Unreleased]

- feat: something new (#501)
- fix: something broken (#502)

## [0.2.18] - 2026-10-12

- feat(usage): send per-message usage records with the usage upload (#411)

## [0.2.17] - 2026-10-12

- fix(auth): send the API key once in x-api-key (#400)
`;

function copyRepo(changelog = CHANGELOG) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "release-scripts-"));
  mkdirSync(path.join(dir, ".claude-plugin"));
  for (const file of FILES) cpSync(path.join(repo, file), path.join(dir, file));
  writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
  return dir;
}

const run = (script, args, cwd) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
const json = (dir, file) => JSON.parse(readFileSync(path.join(dir, file), "utf8"));
const current = JSON.parse(
  readFileSync(path.join(repo, ".claude-plugin/plugin.json"), "utf8")
).version;

function changedLines(dir, file) {
  const before = readFileSync(path.join(repo, file), "utf8").split("\n");
  const after = readFileSync(path.join(dir, file), "utf8").split("\n");
  assert.equal(after.length, before.length, `${file} keeps its line count`);
  return after.filter((line, i) => line !== before[i]);
}

test("release:version sets the version in all five places and nowhere else", () => {
  const dir = copyRepo();
  const res = run(versionScript, ["0.3.0", "--date", "2026-10-13"], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(json(dir, "package.json").version, "0.3.0");
  assert.equal(json(dir, "package-lock.json").version, "0.3.0");
  assert.equal(json(dir, "package-lock.json").packages[""].version, "0.3.0");
  assert.equal(json(dir, ".claude-plugin/plugin.json").version, "0.3.0");
  const market = json(dir, ".claude-plugin/marketplace.json");
  assert.equal(market.plugins.find((p) => p.name === "armorclaude").version, "0.3.0");
  assert.equal(market.plugins.find((p) => p.name === "armorclaude-dev").version, undefined);
  assert.equal(
    market.metadata.version,
    json(repo, ".claude-plugin/marketplace.json").metadata.version
  );
  assert.deepEqual(changedLines(dir, "package.json"), ['  "version": "0.3.0",']);
  assert.deepEqual(changedLines(dir, "package-lock.json"), [
    '  "version": "0.3.0",',
    '      "version": "0.3.0",',
  ]);
  assert.deepEqual(changedLines(dir, ".claude-plugin/plugin.json"), ['  "version": "0.3.0",']);
  assert.deepEqual(changedLines(dir, ".claude-plugin/marketplace.json"), [
    '      "version": "0.3.0",',
  ]);
});

test("release:version files the Unreleased changes under the new version", () => {
  const dir = copyRepo();
  assert.equal(run(versionScript, ["0.3.0", "--date", "2026-10-13"], dir).status, 0);
  const text = readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
  assert.match(
    text,
    /## \[Unreleased\]\n\n## \[0\.3\.0\] - 2026-10-13\n\n- feat: something new \(#501\)\n- fix: something broken \(#502\)\n\n## \[0\.2\.18\]/
  );
  const notes = run(notesScript, ["0.3.0"], dir);
  assert.equal(notes.status, 0, notes.stderr);
  assert.equal(notes.stdout, "- feat: something new (#501)\n- fix: something broken (#502)\n");
});

test("release:version refuses a bad version, a version already in the CHANGELOG, and nothing to release", () => {
  for (const args of [["v0.3.0"], ["0.3"], ["0.2.18"]]) {
    const dir = copyRepo();
    const res = run(versionScript, args, dir);
    assert.notEqual(res.status, 0, args.join(" "));
    assert.equal(json(dir, "package.json").version, current, "nothing was written");
  }
  const empty = copyRepo(
    CHANGELOG.replace(/- feat: something new \(#501\)\n- fix: something broken \(#502\)\n\n/, "")
  );
  const res = run(versionScript, ["0.3.0"], empty);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Unreleased/);
});

test("--check passes when all five fields agree and names the file that does not", () => {
  const dir = copyRepo();
  assert.equal(run(versionScript, ["--check", current], dir).status, 0);
  const plugin = path.join(dir, ".claude-plugin/plugin.json");
  writeFileSync(
    plugin,
    readFileSync(plugin, "utf8").replace(`"version": "${current}"`, '"version": "9.9.9"')
  );
  const res = run(versionScript, ["--check", current], dir);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /\.claude-plugin\/plugin\.json/);
});

test("release:notes prints one version's section and fails for a missing or empty one", () => {
  const dir = copyRepo();
  const notes = run(notesScript, ["0.2.17"], dir);
  assert.equal(notes.status, 0, notes.stderr);
  assert.equal(notes.stdout, "- fix(auth): send the API key once in x-api-key (#400)\n");
  assert.notEqual(run(notesScript, ["0.1.0"], dir).status, 0);
  assert.notEqual(
    run(
      notesScript,
      ["Unreleased"],
      copyRepo(CHANGELOG.replace(/- feat[^\n]*\n- fix[^\n]*\n\n/, ""))
    ).status,
    0
  );
});

test("the repository's CHANGELOG has notes for the current plugin version", () => {
  const res = run(notesScript, [current], repo);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.trim().length > 0);
});
