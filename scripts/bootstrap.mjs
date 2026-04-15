// Lazily install npm dependencies on first run, then dispatch to the
// real hook-router or MCP server. This makes the plugin work after
// `claude plugin install` even when the cache directory has no node_modules.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(__dirname);
const sentinel = path.join(pluginRoot, "node_modules", "@armoriq", "sdk", "package.json");

if (!existsSync(sentinel)) {
  process.stderr.write("[armorclaude] installing dependencies (one-time)...\n");
  const result = spawnSync("npm", ["install", "--omit=dev", "--silent", "--no-audit", "--no-fund"], {
    cwd: pluginRoot,
    stdio: ["ignore", "ignore", "inherit"]
  });
  if (result.status !== 0) {
    process.stderr.write("[armorclaude] npm install failed (exit " + result.status + ")\n");
    process.exit(1);
  }
}

const target = process.argv[2];
if (target === "router") {
  await import("./hook-router.mjs");
} else if (target === "mcp") {
  await import("./policy-mcp.mjs");
} else {
  process.stderr.write("[armorclaude] bootstrap: unknown target '" + target + "'\n");
  process.exit(2);
}
