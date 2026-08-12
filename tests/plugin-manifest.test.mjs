import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readJson(relPath) {
  return JSON.parse(await readFile(path.join(repoRoot, relPath), "utf8"));
}

// Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} literally. It does NOT implement
// shell parameter expansion, so a bash-style default such as
// ${CLAUDE_PLUGIN_ROOT:-.} is not recognised and collapses to ".", which then
// resolves against the user's cwd instead of the plugin directory. The MCP
// server then fails to start with "MCP error -32000: Connection closed" and
// register_intent_plan is never exposed — enforcement silently does nothing.
test("plugin manifests reference CLAUDE_PLUGIN_ROOT without shell default syntax", async () => {
  for (const relPath of [".mcp.json", "hooks/hooks.json"]) {
    const raw = await readFile(path.join(repoRoot, relPath), "utf8");
    assert.ok(
      !raw.includes("CLAUDE_PLUGIN_ROOT:-"),
      `${relPath} uses \${CLAUDE_PLUGIN_ROOT:-...}; Claude Code does not expand shell defaults`
    );
  }
});

test("MCP server is launched via an absolute plugin-root path", async () => {
  const mcp = await readJson(".mcp.json");
  const server = mcp.mcpServers["armorclaude-policy"];
  assert.ok(server, "armorclaude-policy server must be declared");
  const entry = server.args.find((arg) => arg.includes("bootstrap.mjs"));
  assert.ok(entry, "bootstrap.mjs must be in the server args");
  assert.equal(entry, "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs");
});

// A fix that ships without a version bump never reaches existing installs:
// `claude plugin update` compares versions and reports "already at the latest
// version", leaving users pinned to the old commit.
test("plugin version is consistent across every manifest", async () => {
  const pkg = await readJson("package.json");
  const plugin = await readJson(".claude-plugin/plugin.json");
  const marketplace = await readJson(".claude-plugin/marketplace.json");
  const entry = marketplace.plugins.find((p) => p.name === "armorclaude");

  assert.ok(entry, "armorclaude must be listed in marketplace.json");
  assert.equal(plugin.version, pkg.version, "plugin.json version must match package.json");
  assert.equal(entry.version, pkg.version, "marketplace.json version must match package.json");
});
