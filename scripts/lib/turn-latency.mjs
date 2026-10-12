import path from "node:path";
import armoriqSdk from "@armoriq/sdk-dev";
import { readJson, writeJson } from "./fs-store.mjs";

const { TurnTimingStore, claudeTurnLatencies, turnLatencyPayloads } = armoriqSdk;

export const turnStore = (dir) => new TurnTimingStore(path.join(dir, "turns"));

function turnSamples(dir, { sessionId, transcript }, cutoff) {
  const native = claudeTurnLatencies(transcript);
  const samples = native.length ? native : turnStore(dir).samples(sessionId);
  return samples.filter((sample) => sample.startedAtMs >= cutoff);
}

export async function postTurnLatency(job, log) {
  const { dir, client, config, deviceId, deviceName, session } = job;
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
