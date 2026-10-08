import { obsShipSpool } from "./lib/observability.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
await obsShipSpool(JSON.parse(Buffer.concat(chunks).toString("utf8")));
