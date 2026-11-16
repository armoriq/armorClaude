import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBackend, startHookSession, waitFor } from "./helpers/hook-session.mjs";
import {
  assistant,
  isoAgo,
  sessionBatches,
  stop,
  until,
  withSession,
  writeSession,
} from "./helpers/live-usage.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(
  readFileSync(path.join(repo, ".claude-plugin", "plugin.json"), "utf8")
);

const tokenReply = () => [
  200,
  {
    success: true,
    plan_id: randomUUID(),
    plan_hash: "plan-hash",
    intent_reference: "intent-ref",
    token: { issued_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 3600 },
    step_proofs: [],
  },
];

function pluginDataDir(name) {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "aq-client-header-")), name);
  mkdirSync(dir);
  return dir;
}

for (const [dataDirName, product] of [
  ["armorclaude-dev-armoriq", "armorclaude-dev"],
  ["armorclaude-armoriq", "armorclaude"],
  ["armorclaude", "armorclaude"],
]) {
  test(`every backend call from a ${dataDirName} install names ${product}/<plugin version>`, async (t) => {
    const backend = await startBackend({ "POST /iap/sdk/token": tokenReply });
    const { hook } = await startHookSession(t, backend, {
      CLAUDE_PLUGIN_DATA: pluginDataDir(dataDirName),
    });
    const ls = { tool_name: "Bash", tool_input: { command: "ls" } };
    await hook({ hook_event_name: "SessionStart", source: "startup" });
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "list the files" });
    await hook({ hook_event_name: "PreToolUse", ...ls });
    await hook({ hook_event_name: "PostToolUse", ...ls, tool_response: { stdout: "a\n" } });
    await hook({ hook_event_name: "Stop" });
    await waitFor(() => backend.auditRows.length > 0, 15_000, "an audit upload");
    const routes = new Set(backend.requests.map((r) => r.route));
    assert.ok(routes.has("POST /iap/sdk/token"), [...routes].join(", "));
    assert.ok(routes.has("POST /iap/audit/batch"), [...routes].join(", "));
    assert.deepEqual(
      backend.requests.filter((r) => r.client !== `${product}/${version}`).map((r) => r.route),
      []
    );
  });
}

test("the usage upload names armorclaude/<plugin version> on every call", () =>
  withSession(async (b, h, id) => {
    writeSession(h, id, [
      assistant(id, "a", isoAgo(60_000), { input_tokens: 4, output_tokens: 0 }),
    ]);
    await stop(h, b.url, false, id);
    await until(() => sessionBatches(b, id).length > 0, "the usage batch");
    const routes = new Set(b.clients.map((c) => c.route));
    assert.ok(routes.has("POST /dashboard/token-usage/batch"), [...routes].join(", "));
    assert.deepEqual(
      b.clients.filter((c) => c.client !== `armorclaude/${version}`).map((c) => c.route),
      []
    );
  }));
