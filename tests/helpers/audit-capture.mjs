import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loginTag } from "../../scripts/lib/audit-wal.mjs";
import { loadConfigWithLogins } from "./login-profile.mjs";
const PLAN = { goal: "read the repo", steps: [{ action: "Read" }, { action: "Glob" }] };

export async function captureSession(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aq-block-capture-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = {
    ...loadConfigWithLogins([], { CLAUDE_PLUGIN_DATA: dataDir }),
    apiKey: `ak_test_${randomUUID()}`,
    backendEndpoint: "http://127.0.0.1:1",
    auditEnabled: true,
    daemonEnabled: false,
    intentRequired: false,
    cryptoPolicyEnabled: false,
    csrgVerifyEnabled: false,
    mode: "enforce",
  };
  const state = {
    promptId: "prompt-original",
    countedPlanId: "11111111-1111-4111-8111-111111111111",
    tokenPlanId: "22222222-2222-4222-8222-222222222222",
    plan: PLAN,
  };
  const save = () =>
    writeFile(config.runtimeFile, JSON.stringify({ sessions: { "session-1": state } }));
  await save();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ orgId: "org-test", agents: [] }))
  );
  const rows = async () => {
    try {
      const text = await readFile(
        path.join(
          dataDir,
          "audit",
          loginTag(config.backendEndpoint, config.apiKey),
          "outbox-current.jsonl"
        ),
        "utf8"
      );
      return text.trim().split("\n").filter(Boolean).map(JSON.parse);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return { config, state, save, rows };
}
