import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function readJson(relPath) {
  return JSON.parse(await readFile(path.join(repoRoot, relPath), "utf8"));
}

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

// Claude Code takes a plugin's version from plugin.json first, then from its
// marketplace entry, then from the commit. Stable installs update when the
// armorclaude entry moves; the dev variant has neither, so every dev commit is
// a new version. A version in plugin.json would freeze the dev channel.
test("the stable version lives in the marketplace entry and package.json, not plugin.json", async () => {
  const pkg = await readJson("package.json");
  const plugin = await readJson(".claude-plugin/plugin.json");
  const marketplace = await readJson(".claude-plugin/marketplace.json");
  const entry = marketplace.plugins.find((p) => p.name === "armorclaude");

  assert.ok(entry, "armorclaude must be listed in marketplace.json");
  assert.equal(plugin.version, undefined, "plugin.json must not set a version");
  assert.equal(entry.version, pkg.version, "marketplace.json version must match package.json");
});

test("dev variant stays discoverable from the published catalog", async () => {
  const marketplace = await readJson(".claude-plugin/marketplace.json");
  const entry = marketplace.plugins.find((p) => p.name === "armorclaude-dev");

  assert.ok(entry, "armorclaude-dev must be listed in marketplace.json");
  assert.equal(entry.source?.source, "url", "dev variant must install from a git URL");
  assert.equal(
    entry.source?.url,
    "https://github.com/armoriq/armorClaude.git",
    "dev variant must clone this repo over HTTPS so install needs no GitHub SSH key"
  );
  assert.equal(entry.source?.ref, "dev", "dev variant must track the dev branch");
  assert.equal(
    entry.version,
    undefined,
    "dev variant must not pin a version, so Claude Code versions it by dev's commit"
  );
});
