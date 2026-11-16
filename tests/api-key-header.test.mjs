import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { API_KEY, startHookSession, waitFor } from "./helpers/hook-session.mjs";

async function guardedBackend() {
  const audits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const reply = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url !== "/iap/audit/batch") return reply(404, {});
      const named = (name) =>
        req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name)
          .length;
      audits.push({
        apiKey: req.headers["x-api-key"],
        authorization: req.headers.authorization,
        apiKeyHeaders: named("x-api-key"),
        authorizationHeaders: named("authorization"),
      });
      if (req.headers["x-api-key"] !== API_KEY)
        return reply(401, { message: "Invalid or expired API key" });
      const { rows } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return reply(200, { written: rows.length, failures: [] });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    audits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

test("backend calls send the API key once in x-api-key and once as a Bearer token", async (t) => {
  const backend = await guardedBackend();
  const { hook } = await startHookSession(t, backend);
  await hook({ hook_event_name: "SessionStart", source: "startup" });
  const ls = { tool_name: "Bash", tool_input: { command: "ls" } };
  await hook({ hook_event_name: "PostToolUse", ...ls, tool_response: { stdout: "a\n" } });
  await hook({ hook_event_name: "Stop" });
  await waitFor(() => backend.audits.length > 0, 15_000, "an audit upload");
  assert.deepEqual(backend.audits[0], {
    apiKey: API_KEY,
    authorization: `Bearer ${API_KEY}`,
    apiKeyHeaders: 1,
    authorizationHeaders: 1,
  });
});
