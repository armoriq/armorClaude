#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { changelogSection } from "./lib/changelog.mjs";

const [version] = process.argv.slice(2);
const notes = version ? changelogSection(readFileSync("CHANGELOG.md", "utf8"), version) : null;
if (!notes) {
  process.stderr.write(`CHANGELOG.md has no entries for ${version ?? "(no version given)"}\n`);
  process.exit(1);
}
process.stdout.write(`${notes}\n`);
