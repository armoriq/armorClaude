import path from "node:path";
import { readJson, writeJson } from "./fs-store.mjs";
import { sdkModule } from "./sdk.mjs";

export function turnStore(dir) {
  const { TurnTimingStore } = sdkModule("turn_latency");
  return new TurnTimingStore(path.join(dir, "turns"));
}

function turnSamples(dir, { sessionId, transcript }, cutoff) {
  const { claudeTurnLatencies } = sdkModule("turn_latency");
  const native = claudeTurnLatencies(transcript);
  const samples = native.length ? native : turnStore(dir).samples(sessionId);
  return samples.filter((sample) => sample.startedAtMs >= cutoff);
}

export async function postTurnLatency(job, log) {
  const { dir, client, config, deviceId, deviceName, session } = job;
  const { turnLatencyPayloads } = sdkModule("turn_latency");
  const identity = {
    product: config.productSlug,
    sessionId: session.sessionId,
    deviceId,
    deviceName,
  };
  const payloads = turnLatencyPayloads(identity, turnSamples(dir, session, job.cutoff));
  const sentPath = path.join(dir, `${session.sessionId}.latency.json`);
  const sent = await readJson(sentPath, {});
  for (const payload of payloads) {
    const digest = JSON.stringify(payload);
    if (sent[payload.usageDate] === digest) continue;
    const res = await client.recordTokenLatency(payload);
    if (res.ok) sent[payload.usageDate] = digest;
    else log(`turn latency for ${payload.usageDate} not sent (${res.reason})`);
  }
  await writeJson(sentPath, sent);
}
