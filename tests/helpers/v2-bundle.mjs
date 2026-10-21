import { createServer } from "node:http";

// A backend that answers only the v2 bundle, with no agent policy, so engine
// tests whose other calls must fail still get past the v2 decision.
const server = createServer((req, res) => {
  const bundle = req.method === "GET" && req.url.startsWith("/policy/bundles/current");
  res.writeHead(bundle ? 200 : 404, { "content-type": "application/json" });
  res.end(JSON.stringify(bundle ? { orgId: "org-test", agents: [] } : {}));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
server.unref();

export const NO_V2_POLICY_BACKEND = `http://127.0.0.1:${server.address().port}`;
