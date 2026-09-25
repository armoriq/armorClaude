import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deviceIdentity } from "../scripts/lib/device.mjs";
import {
  loadRuntimeState,
  saveRuntimeState,
  upsertSession,
} from "../scripts/lib/runtime-state.mjs";

test("deviceIdentity reuses the id the ArmorIQ CLI persisted", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ac-device-"));
  const idPath = path.join(dir, "device-id");
  writeFileSync(idPath, "c5f09b41-cli-device\n");
  const { deviceId, deviceName } = deviceIdentity({ ARMORIQ_DEVICE_ID_PATH: idPath });
  assert.equal(deviceId, "c5f09b41-cli-device");
  assert.ok(deviceName.length > 0);
});

test("deviceIdentity falls back to a stable hostname hash without a CLI id", () => {
  const missing = path.join(tmpdir(), "no-such-dir", "device-id");
  const a = deviceIdentity({ ARMORIQ_DEVICE_ID_PATH: missing });
  const b = deviceIdentity({ ARMORIQ_DEVICE_ID_PATH: missing });
  assert.match(a.deviceId, /^dev_[0-9a-f]{16}$/);
  assert.equal(a.deviceId, b.deviceId);
});

async function stopPosts() {
  const { handleStop } = await import("../scripts/lib/engine.mjs");
  const intentMod = await import("../scripts/lib/intent.mjs");
  const tmp = mkdtempSync(path.join(tmpdir(), "ac-stop-"));
  const transcript = path.join(tmp, "sess-tokens.jsonl");
  const line = (id, timestamp, input) =>
    JSON.stringify({
      type: "assistant",
      cwd: "/work/repo-a",
      timestamp,
      requestId: `req-${id}`,
      message: { id, model: "claude-opus", usage: { input_tokens: input, output_tokens: 1 } },
    });
  writeFileSync(
    transcript,
    [
      line("m1", "2026-09-20T23:55:00Z", 10),
      line("m1", "2026-09-20T23:55:01Z", 10),
      line("m2", "2026-09-21T00:05:00Z", 20),
    ].join("\n")
  );
  mkdirSync(path.join(tmp, "sess-tokens", "subagents"), { recursive: true });
  writeFileSync(
    path.join(tmp, "sess-tokens", "subagents", "agent-a1.jsonl"),
    [line("m2", "2026-09-21T00:05:00Z", 20), line("s1", "2026-09-21T00:06:00Z", 300)].join("\n")
  );
  const config = {
    mode: "enforce",
    dataDir: tmp,
    policyFile: path.join(tmp, "policy.json"),
    runtimeFile: path.join(tmp, "runtime.json"),
    backendEndpoint: "http://127.0.0.1:3000",
    csrgEndpoint: "http://127.0.0.1:8000",
    apiKey: "ak_test_tokens",
    useSdkIntent: false,
    productSlug: "armorclaude",
    llmId: "claude-code",
    userId: "u",
    agentId: "a",
    timeoutMs: 5000,
    maxRetries: 1,
    verifySsl: true,
    validitySeconds: 60,
  };
  const state = await loadRuntimeState(config.runtimeFile);
  upsertSession(state, "sess-tokens", { lastPrompt: "p" });
  await saveRuntimeState(config.runtimeFile, state);
  const client = intentMod.getSdkClient(config);
  const original = client.recordTokenUsage;
  const posts = [];
  client.recordTokenUsage = async (payload) => {
    posts.push(payload);
    return { ok: true };
  };
  try {
    await handleStop(
      { hook_event_name: "Stop", session_id: "sess-tokens", transcript_path: transcript },
      config
    );
  } finally {
    client.recordTokenUsage = original;
  }
  assert.ok(posts.every((p) => p.deviceId && p.sessionId === "sess-tokens"));
  return posts.map((p) => [p.usageDate, p.repo, p.entries[0].inputTokens]);
}

test("Stop reports one row per UTC day for the session and its subagents", async () => {
  assert.deepEqual(await stopPosts(), [
    ["2026-09-20", "/work/repo-a", 10],
    ["2026-09-21", "/work/repo-a", 320],
  ]);
});
