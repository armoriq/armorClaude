import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Claude Code installs each version in its own directory and a dev-channel
// update keeps package.json's version, so the install path tells two builds apart.
export const DAEMON_VERSION = `${
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version
}+${fileURLToPath(new URL("../..", import.meta.url))}`;
