import { obsFetchLease } from "./lib/observability.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
await obsFetchLease(JSON.parse(Buffer.concat(chunks).toString("utf8")));
