import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  __resetObsForTests,
  observeHook,
  obsFlushAll,
  obsShipInProcess,
} from "../scripts/lib/observability.mjs";

const SESSION_ID = "57575757-5757-4575-8575-575757575757";

async function startIngest() {
  const posts = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      posts.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: 1, rejected: 0 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    observabilityEnabled: true,
    observabilityEndpoint: `http://127.0.0.1:${server.address().port}`,
    observabilityProduct: "armorclaude",
    apiKey: "ak_live_test0000000000000000000000000000",
    agentId: "claude-code",
    sanitize: { maxChars: 2000, maxDepth: 4, maxKeys: 50, maxItems: 50 },
  };
  return { posts, config, close: () => new Promise((resolve) => server.close(resolve)) };
}

const preToolUse = {
  session_id: SESSION_ID,
  tool_name: "Bash",
  tool_input: { command: "ls" },
};
const postToolUse = { ...preToolUse, tool_response: { stdout: "a\nb" } };
const allow = { hookSpecificOutput: { permissionDecision: "allow" } };

function spansOf(posts) {
  return posts.flatMap((p) => p.body.batches.flatMap((b) => b.spans));
}

test("in-process fallback ships PreToolUse and PostToolUse spans with the session id", async () => {
  const ingest = await startIngest();
  try {
    __resetObsForTests();
    await observeHook("PreToolUse", preToolUse, allow, ingest.config);
    await obsShipInProcess(SESSION_ID, ingest.config);

    __resetObsForTests();
    await observeHook("PostToolUse", postToolUse, null, ingest.config);
    await obsShipInProcess(SESSION_ID, ingest.config);

    assert.equal(ingest.posts.length, 2);
    for (const post of ingest.posts) {
      assert.equal(post.url, "/observability/spans");
      assert.equal(post.body.sessionId, SESSION_ID);
      for (const batch of post.body.batches) assert.equal(batch.trace.sessionId, SESSION_ID);
    }
    const spans = spansOf(ingest.posts);
    const names = spans.map((s) => s.name);
    assert.ok(names.includes("iap.check"));
    assert.ok(names.includes("tool.report"));
    assert.ok(spans.some((s) => s.kind === "policy_call"));
    for (const span of spans) assert.equal(span.sessionId, SESSION_ID);
  } finally {
    __resetObsForTests();
    await ingest.close();
  }
});

test("daemon mode keeps one trace per turn and ships it only after Stop", async () => {
  const ingest = await startIngest();
  try {
    __resetObsForTests();
    await observeHook(
      "UserPromptSubmit",
      { session_id: SESSION_ID, prompt: "list files" },
      null,
      ingest.config
    );
    await observeHook("PreToolUse", preToolUse, allow, ingest.config);
    await observeHook("PostToolUse", postToolUse, null, ingest.config);
    await obsFlushAll();
    assert.equal(ingest.posts.length, 0);

    await observeHook("Stop", { session_id: SESSION_ID }, null, ingest.config);
    await obsFlushAll();

    assert.equal(ingest.posts.length, 1);
    const [batch, ...rest] = ingest.posts[0].body.batches;
    assert.equal(rest.length, 0);
    assert.equal(batch.trace.name, "iap.plan");
    assert.equal(batch.trace.sessionId, SESSION_ID);
    const names = batch.spans.map((s) => s.name);
    for (const name of ["iap.plan.start", "iap.check", "tool.report"]) {
      assert.ok(names.includes(name), name);
    }
  } finally {
    __resetObsForTests();
    await ingest.close();
  }
});
