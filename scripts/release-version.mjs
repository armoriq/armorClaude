#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { changelogSection } from "./lib/changelog.mjs";

const SEMVER = /^\d+\.\d+\.\d+$/;
const TOP_LEVEL = /^( {2}"version": ")[^"]+(")/m;
const FIELDS = [
  ["package.json", (j) => j.version, [TOP_LEVEL]],
  [
    "package-lock.json",
    (j) => [j.version, j.packages[""].version],
    [TOP_LEVEL, /("": \{\n(?: {6}.*\n)*? {6}"version": ")[^"]+(")/],
  ],
  [".claude-plugin/plugin.json", (j) => j.version, [TOP_LEVEL]],
  [
    ".claude-plugin/marketplace.json",
    (j) => j.plugins.find((p) => p.name === "armorclaude")?.version,
    [/("name": "armorclaude",\n(?: {6}.*\n)*? {6}"version": ")[^"]+(")/],
  ],
];

const read = (file) => readFileSync(file, "utf8");
const versionsIn = (file, get) => [get(JSON.parse(read(file)))].flat();

function mismatches(version) {
  return FIELDS.filter(([file, get]) => versionsIn(file, get).some((v) => v !== version)).map(
    ([file, get]) => `${file} has ${versionsIn(file, get).join(", ")}`
  );
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function check(version) {
  const wrong = mismatches(version);
  if (wrong.length) fail(`version files disagree with ${version}: ${wrong.join("; ")}`);
}

function bump(version, date) {
  const changelog = read("CHANGELOG.md");
  if (changelogSection(changelog, version) !== null) fail(`CHANGELOG.md already has ${version}`);
  if (!changelogSection(changelog, "Unreleased")) fail("CHANGELOG.md has nothing under Unreleased");
  for (const [file, , patterns] of FIELDS) {
    writeFileSync(
      file,
      patterns.reduce((text, re) => text.replace(re, `$1${version}$2`), read(file))
    );
  }
  writeFileSync(
    "CHANGELOG.md",
    changelog.replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] - ${date}\n`)
  );
  check(version);
}

const args = process.argv.slice(2);
const checking = args[0] === "--check";
const version = checking ? args[1] : args[0];
if (!SEMVER.test(version ?? "")) fail(`not a version: ${version ?? "(none)"}`);
if (checking) check(version);
else {
  const dateAt = args.indexOf("--date");
  bump(version, dateAt > 0 ? args[dateAt + 1] : new Date().toISOString().slice(0, 10));
}
