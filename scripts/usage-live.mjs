#!/usr/bin/env node
import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { keyOwner } from "./lib/backend-client.mjs";
import { loadConfig } from "./lib/config.mjs";
import { deviceIdentity } from "./lib/device.mjs";
import { readJson, writeJson } from "./lib/fs-store.mjs";
import { getSdkClient } from "./lib/intent.mjs";
import {
  acknowledge,
  allocateRevision,
  captureSession,
  changedSnapshots,
  liveDir,
  liveTranscript,
  loginCutoff,
  newBatchId,
  packBatches,
  projectsDir,
  setGeneration,
  storedGeneration,
  tryFileLock,
} from "./lib/live-usage.mjs";
import { noteTokenUsageResult } from "./lib/relogin.mjs";

const HARD_STOP_MS = 120_000;
const [sessionId, transcriptArg] = process.argv.slice(2);

function log(message) {
  process.stderr.write(`[usage-live] ${new Date().toISOString()} ${sessionId} ${message}\n`);
}

const describe = (r) => (r.status ? `HTTP ${r.status}: ${r.reason}` : r.reason);

async function generationFor({ config, client, dir }, refresh = false) {
  const stored = refresh ? null : await storedGeneration(dir);
  if (stored) return stored;
  const res = await client.initializeUsageStream();
  noteTokenUsageResult(config, res);
  if (!res.ok) throw new Error(`could not open the usage stream (${describe(res)})`);
  await setGeneration(dir, res.value.generation);
  return res.value.generation;
}

async function sendBatch(job, generation, snapshots) {
  const send = (gen) =>
    job.client.recordTokenUsageBatch({
      generation: gen,
      batchId: newBatchId(),
      deviceName: job.deviceName,
      snapshots,
    });
  const first = await send(generation);
  if (first.ok || first.status !== 409 || !/generation/i.test(first.reason)) return first;
  return send(await generationFor(job, true));
}

async function uploadOnce(job) {
  const { config, dir, transcript, cutoff } = job;
  const sessionFile = path.join(dir, `${sessionId}.json`);
  let acknowledged = (await readJson(sessionFile, {})).acknowledged ?? {};
  const revision = await allocateRevision(dir);
  const capture = captureSession({ transcript, sessionId, cutoff });
  for (const p of capture.problems) log(`not read ${p.path} (${p.reason})`);
  const snapshots = changedSnapshots({ capture, sessionId, revision, acknowledged });
  if (!snapshots.length) return;
  const generation = await generationFor(job);
  let sent = 0;
  for (const batch of packBatches(snapshots)) {
    const result = await sendBatch(job, generation, batch);
    noteTokenUsageResult(config, result);
    if (!result.ok) {
      log(`sent ${sent} of ${snapshots.length} session-hour(s), then ${describe(result)}`);
      return;
    }
    sent += batch.length;
    acknowledged = acknowledge(acknowledged, batch);
    await writeJson(sessionFile, { acknowledged });
  }
  log(`sent ${sent} session-hour(s) at revision ${revision}`);
}

async function prepare(config) {
  const transcript = liveTranscript(projectsDir(), sessionId, transcriptArg);
  if (!transcript) return log("not a Claude Code transcript of this session, nothing sent");
  const cutoff = loginCutoff(config);
  if (cutoff === null) return log("the saved login has no usable login history, nothing sent");
  const owner = await keyOwner(config);
  if (!owner.ok || owner.userId !== config.userId)
    return log("the API key does not belong to the saved login's user, nothing sent");
  const { deviceId, deviceName } = deviceIdentity();
  const dir = liveDir(config.dataDir, {
    backend: config.backendEndpoint,
    product: config.productSlug,
    userId: config.userId,
    deviceId,
  });
  return { config, client: getSdkClient(config), dir, transcript, cutoff, deviceName };
}

async function main() {
  const config = loadConfig(process.env);
  if (!config.usageSyncEnabled) return;
  const job = await prepare(config);
  if (!job) return;
  const lockPath = path.join(job.dir, `${sessionId}.lock`);
  const pendingPath = path.join(job.dir, `${sessionId}.pending`);
  for (;;) {
    const release = await tryFileLock(lockPath);
    if (!release) return;
    try {
      while (existsSync(pendingPath)) {
        unlinkSync(pendingPath);
        await uploadOnce(job);
      }
    } finally {
      await release();
    }
    if (!existsSync(pendingPath)) return;
  }
}

const hardStop = setTimeout(() => {
  log(`still running after ${HARD_STOP_MS}ms, exiting`);
  process.exit(1);
}, HARD_STOP_MS);
hardStop.unref();

main().catch((err) => {
  log(`failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
