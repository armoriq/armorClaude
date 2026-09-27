import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

// The usage sync is the only writer of token-usage rows (#156, #158).
test("Stop sends no request to the backend or CSRG", async () => {
  const { handleStop } = await import("../scripts/lib/engine.mjs");
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(500).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const tmp = mkdtempSync(path.join(tmpdir(), "ac-stop-"));
  const transcript = path.join(tmp, "sess-tokens.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({
      type: "assistant",
      cwd: "/work/repo-a",
      timestamp: "2026-09-21T00:05:00Z",
      requestId: "req-m1",
      message: { id: "m1", model: "claude-opus", usage: { input_tokens: 20, output_tokens: 1 } },
    })
  );
  const config = {
    mode: "enforce",
    dataDir: tmp,
    policyFile: path.join(tmp, "policy.json"),
    runtimeFile: path.join(tmp, "runtime.json"),
    backendEndpoint: endpoint,
    csrgEndpoint: endpoint,
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
  try {
    await handleStop(
      { hook_event_name: "Stop", session_id: "sess-tokens", transcript_path: transcript },
      config
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.deepEqual(requests, []);
  const saved = await loadRuntimeState(config.runtimeFile);
  assert.equal(typeof saved.sessions["sess-tokens"].lastStopAt, "number");
  assert.equal(saved.sessions["sess-tokens"].lastTokenTotal, undefined);
});
