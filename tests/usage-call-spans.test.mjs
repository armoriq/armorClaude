import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __resetObsForTests,
  __setOtelTestHooksForTests,
  observeHook,
} from "../scripts/lib/observability.mjs";

const OTEL_ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith("OTEL_"));
const savedEnv = Object.fromEntries(OTEL_ENV_KEYS.map((k) => [k, process.env[k]]));
for (const key of OTEL_ENV_KEYS) delete process.env[key];
test.after(() => {
  Object.assign(process.env, savedEnv);
  __setOtelTestHooksForTests(null);
});

const stubLease = async () => ({
  captureMode: "metadata",
  revision: 1,
  expiresAt: new Date(Date.now() + 3600_000),
  authoritative: true,
  contentCaptureAllowed: false,
  externalContentCaptureAllowed: false,
  externalContentAllowed: false,
  contentReasonCode: "test",
  debugExpiresAt: null,
});

const BASE_MS = Date.parse("2026-10-11T10:00:00.000Z");
const startMs = (span) => span.startTime[0] * 1000 + span.startTime[1] / 1e6;
const spanIdOf = (key) => createHash("sha256").update(key).digest("hex").slice(0, 16);

function harness() {
  __resetObsForTests();
  __setOtelTestHooksForTests({ leaseFetcher: stubLease });
  const dir = mkdtempSync(path.join(os.tmpdir(), "armorclaude-calls-"));
  const config = {
    observabilityEnabled: true,
    observabilityEndpoint: "http://127.0.0.1:1",
    observabilityProduct: "armorclaude",
    apiKey: "ak_test_usagecalls00000000000000000",
    agentId: "claude-code",
    userId: "claude-user",
    dataDir: path.join(dir, "data"),
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
  };
  const spool = path.join(config.dataDir, "obs-spool");
  const spans = () =>
    (existsSync(spool) ? readdirSync(spool) : [])
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => JSON.parse(readFileSync(path.join(spool, name), "utf8")).spans);
  const generations = () => spans().filter((s) => s.name === "gen_ai.chat");
  const hook = (event, sessionId, input = {}) =>
    observeHook(event, { session_id: sessionId, hook_event_name: event, ...input }, null, config);
  return { dir, spans, generations, hook };
}

function assistantLines(sessionId, n, { offset = 0 } = {}) {
  const line = (block) =>
    JSON.stringify({
      type: "assistant",
      sessionId,
      requestId: `req_${offset + n}`,
      timestamp: new Date(BASE_MS + (offset + n) * 1000).toISOString(),
      message: {
        id: `msg_${offset + n}`,
        model: "claude-opus-4-1",
        content: [{ type: "text", text: `block ${block}` }],
        usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 },
      },
    });
  return n % 2 === 0 ? [line(0), line(1)] : [line(0)];
}

function transcript(dir, sessionId, lines) {
  const file = path.join(dir, "projects", `${sessionId}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

const messages = (sessionId, count, opts) =>
  Array.from({ length: count }, (_, i) => assistantLines(sessionId, i, opts)).flat();

test("a Stop emits one generation span per unique assistant message, and the next turn's Stop adds none", async () => {
  const { dir, generations, hook } = harness();
  const lines = messages("sess-337", 337);
  assert.equal(lines.length, 506);
  const transcript_path = transcript(dir, "sess-337", lines);
  await hook("SessionStart", "sess-337", { transcript_path });
  await hook("Stop", "sess-337", { transcript_path });
  assert.equal(generations().length, 337);
  await hook("UserPromptSubmit", "sess-337", { prompt: "again", transcript_path });
  await hook("Stop", "sess-337", { transcript_path });
  const spans = generations();
  assert.equal(spans.length, 337);
  const expectedIds = Array.from({ length: 337 }, (_, i) => spanIdOf(`msg_${i}:req_${i}`));
  assert.deepEqual(spans.map((s) => s.spanId).sort(), expectedIds.sort());
  const tokens = spans.reduce(
    (sum, s) =>
      sum + s.attributes["gen_ai.usage.input_tokens"] + s.attributes["gen_ai.usage.output_tokens"],
    0
  );
  assert.equal(tokens, 337 * 12);
});

test("a later Stop emits only the messages added since the last one", async () => {
  const { dir, generations, hook } = harness();
  const transcript_path = transcript(dir, "sess-grow", messages("sess-grow", 3));
  await hook("SessionStart", "sess-grow", { transcript_path });
  await hook("Stop", "sess-grow", { transcript_path });
  await hook("UserPromptSubmit", "sess-grow", { prompt: "more", transcript_path });
  appendFileSync(transcript_path, `${assistantLines("sess-grow", 3).join("\n")}\n`);
  await hook("Stop", "sess-grow", { transcript_path });
  const spans = generations();
  assert.equal(spans.length, 4);
  assert.equal(spans.filter((s) => s.spanId === spanIdOf("msg_3:req_3")).length, 1);
});

test("a resumed session emits only its own new messages, not the ones copied from the parent", async () => {
  const { dir, generations, hook } = harness();
  const copied = messages("sess-parent", 6);
  const fresh = messages("sess-child", 4, { offset: 100 });
  const transcript_path = transcript(dir, "sess-child", [...copied, ...fresh]);
  await hook("SessionStart", "sess-child", { transcript_path });
  await hook("Stop", "sess-child", { transcript_path });
  const ids = generations().map((s) => s.spanId);
  assert.deepEqual(
    ids.sort(),
    [100, 101, 102, 103].map((n) => spanIdOf(`msg_${n}:req_${n}`)).sort()
  );
});

test("a session first seen after its first message starts its root there, and each span keeps its message's time", async () => {
  const { dir, spans, generations, hook } = harness();
  const transcript_path = transcript(dir, "sess-late", messages("sess-late", 3));
  await hook("UserPromptSubmit", "sess-late", { prompt: "go on", transcript_path });
  await hook("Stop", "sess-late", { transcript_path });
  await hook("SessionEnd", "sess-late");
  const roots = spans().filter((s) => s.name === "armoriq.agent.run");
  assert.ok(roots.length > 0, "the root span was spooled");
  for (const root of roots) assert.equal(startMs(root), BASE_MS);
  const gens = generations().sort((a, b) => startMs(a) - startMs(b));
  assert.deepEqual(gens.map(startMs), [BASE_MS, BASE_MS + 1000, BASE_MS + 2000]);
  for (const span of gens) assert.equal(span.attributes["armoriq.timing.provenance"], "reported");
});
