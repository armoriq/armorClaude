import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import {
  link,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { nowEpochSeconds, sha256Hex } from "./common.mjs";
import { ensurePrivateDir, PRIVATE_FILE_MODE, readJson, writeJson } from "./fs-store.mjs";
import { processInfo } from "./usage-sessions.mjs";
import { applyRunTool, closeRun, openRun, reportRunCaptureFailure } from "./runs.mjs";

const MAX_SESSION_AGE_SECONDS = 60 * 60 * 24;
const snapshots = new WeakMap();
const claudeProcesses = new Map();

function claudeProcessInfo(pid) {
  const info = processInfo(pid);
  if (info && process.platform === "linux") {
    try {
      info.executable = readlinkSync(`/proc/${pid}/exe`);
    } catch {
      // The process may have exited before its executable could be read.
    }
  }
  if (info && /^node(?:\.exe)?$/.test(path.basename(info.comm))) {
    try {
      info.args =
        process.platform === "linux"
          ? readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")
          : execFileSync("/bin/ps", ["-o", "args=", "-p", String(pid)], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            });
    } catch {
      // An unavailable command line cannot establish Claude Code ownership.
    }
  }
  return info;
}

export function claudeCodeProcessId(start = process.ppid, lookup = claudeProcessInfo) {
  if (lookup === claudeProcessInfo && claudeProcesses.has(start)) return claudeProcesses.get(start);
  let owner = null;
  const visited = new Set();
  for (let pid = start; Number.isSafeInteger(pid) && pid > 1 && !visited.has(pid); ) {
    visited.add(pid);
    const info = lookup(pid);
    if (!info) break;
    if (
      /^(?:claude|claude-code)(?:\.exe)?$/.test(path.basename(info.comm)) ||
      /\/claude\/versions\/\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(info.executable || info.comm) ||
      /(?:^|[\s/])@anthropic-ai\/(?:claude-code|claude-agent-sdk)\/cli\.js(?:\s|$)/.test(
        info.args || ""
      )
    ) {
      owner = pid;
      break;
    }
    pid = info.ppid;
  }
  if (lookup === claudeProcessInfo) claudeProcesses.set(start, owner);
  return owner;
}

export function resolveProcessSession(
  state,
  pid = process.ppid,
  envId = process.env.CLAUDE_CODE_SESSION_ID
) {
  let latest = null;
  for (const [id, session] of Object.entries(state.sessions)) {
    if (
      session.claudeProcessId !== pid ||
      !session.promptId ||
      !Number.isFinite(session.promptIdentityAt) ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)
    )
      continue;
    if (
      !latest ||
      session.promptIdentityAt > latest.startedAt ||
      (session.promptIdentityAt === latest.startedAt && id === envId)
    )
      latest = { id, startedAt: session.promptIdentityAt };
  }
  if (latest) return latest.id;
  for (const id of [envId, state.activeSessionId]) {
    const session = state.sessions[id];
    if (
      /^[A-Za-z0-9_.:-]{1,128}$/.test(id || "") &&
      session?.promptId &&
      session.claudeProcessId == null
    )
      return id;
  }
  return null;
}

function sessionDefaults() {
  return {
    claudeProcessId: null,
    promptId: null,
    promptGeneration: 0,
    retirementEpoch: 0,
    promptOpenSince: null,
    lastActivityAt: null,
    countedPlanId: null,
    tokenPlanId: null,
    planHash: null,
    kind: null,
    tokenExpiresAt: null,
    authGeneration: 0,
    pendingRequest: null,
    unregisteredLocalPlan: null,
  };
}

async function acquireRuntimeLock(file) {
  await ensurePrivateDir(path.dirname(file));
  const lock = `${file}.lock`;
  const owner = `${lock}.${process.pid}.${randomUUID()}`;
  await writeFile(owner, JSON.stringify({ pid: process.pid, expiresAt: Date.now() + 2000 }), {
    flag: "wx",
    mode: PRIVATE_FILE_MODE,
  });
  let acquired = false;
  const deadline = performance.now() + 5000;
  try {
    while (!acquired) {
      try {
        // A hard link publishes the complete owner file, so no writer can mistake an empty lock for an abandoned one.
        await link(owner, lock);
        acquired = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await clearDeadLock(lock, owner);
        if (performance.now() >= deadline) throw new Error(`Runtime state lock is held: ${lock}`);
        await sleep(10);
      }
    }
  } catch (error) {
    await unlink(owner);
    throw error;
  }
  return async () => {
    try {
      await unlink(lock);
    } finally {
      await unlink(owner);
    }
  };
}

async function withRuntimeLock(file, change) {
  const release = await acquireRuntimeLock(file);
  try {
    return await change();
  } finally {
    await release();
  }
}

async function clearDeadLock(lock, owner) {
  const reclaim = `${lock}.reclaim`;
  try {
    await link(owner, reclaim);
  } catch (error) {
    if (error?.code === "EEXIST") {
      const marker = await lockOwner(reclaim);
      if (marker && (ownerIsDead(marker.pid) || marker.expiresAt <= Date.now()))
        await removeLockOwner(reclaim, marker);
      return;
    }
    throw error;
  }
  try {
    const held = await lockOwner(lock);
    if (held && ownerIsDead(held.pid)) {
      await removeLockOwner(lock, held);
      await clearDeadOwners(lock);
    }
  } finally {
    const marker = await lockOwner(reclaim);
    const own = await lockOwner(owner);
    if (marker && own && marker.ino === own.ino && marker.dev === own.dev)
      await removeLockOwner(reclaim, marker);
  }
}

async function lockOwner(file) {
  try {
    const info = await stat(file);
    const value = JSON.parse(await readFile(file, "utf8"));
    const pid = typeof value === "number" ? value : value?.pid;
    const expiresAt = Number.isFinite(value?.expiresAt) ? value.expiresAt : info.mtimeMs + 2000;
    return { ...info, pid, expiresAt };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) {
      const info = await stat(file).catch(() => null);
      return info ? { ...info, pid: null, expiresAt: info.mtimeMs + 2000 } : null;
    }
    throw error;
  }
}

function ownerIsDead(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    if (error?.code === "EPERM") return false;
    throw error;
  }
}

async function removeLockOwner(file, owner) {
  const current = await stat(file).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  if (current?.ino === owner.ino && current?.dev === owner.dev)
    await unlink(file).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
}

async function clearDeadOwners(lock) {
  const prefix = `${path.basename(lock)}.`;
  for (const name of await readdir(path.dirname(lock))) {
    if (!name.startsWith(prefix) || name === `${path.basename(lock)}.reclaim`) continue;
    const file = path.join(path.dirname(lock), name);
    const owner = await lockOwner(file);
    if (owner && ownerIsDead(owner.pid)) await removeLockOwner(file, owner);
  }
}

export async function loadRuntimeState(runtimeFilePath) {
  const initial = { sessions: {}, mcpRegistry: {} };
  const raw = await readJson(runtimeFilePath, initial);
  const sessions =
    raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object"
      ? raw.sessions
      : {};
  const mcpRegistry =
    raw && typeof raw === "object" && raw.mcpRegistry && typeof raw.mcpRegistry === "object"
      ? raw.mcpRegistry
      : {};
  const discoveredTools = Array.isArray(raw?.discoveredTools) ? raw.discoveredTools : [];
  const state = { sessions, mcpRegistry, discoveredTools };
  if (raw?.runs) state.runs = raw.runs;
  if (typeof raw?.activeSessionId === "string") state.activeSessionId = raw.activeSessionId;
  for (const [id, session] of Object.entries(sessions)) {
    sessions[id] = { ...sessionDefaults(), ...session };
  }
  snapshots.set(state, structuredClone(state));
  return state;
}

export function getSession(runtimeState, sessionId) {
  if (!sessionId) {
    return undefined;
  }
  return runtimeState.sessions[sessionId];
}

export function upsertSession(runtimeState, sessionId, patch) {
  const prev = getSession(runtimeState, sessionId) || {};
  runtimeState.sessions[sessionId] = {
    ...sessionDefaults(),
    ...prev,
    ...patch,
    updatedAt: nowEpochSeconds(),
  };
  return runtimeState.sessions[sessionId];
}

const POST_EXPIRY_GRACE_SECONDS = 60 * 60;

export function pruneSessions(runtimeState) {
  const now = nowEpochSeconds();
  for (const [sessionId, session] of Object.entries(runtimeState.sessions)) {
    const updatedAt = Number.isFinite(session.updatedAt) ? session.updatedAt : 0;
    if (now - updatedAt > MAX_SESSION_AGE_SECONDS) {
      delete runtimeState.sessions[sessionId];
      continue;
    }
    const expiresAt = Number.isFinite(session.expiresAt) ? session.expiresAt : 0;
    if (expiresAt > 0 && now - expiresAt > POST_EXPIRY_GRACE_SECONDS) {
      delete runtimeState.sessions[sessionId];
    }
  }
}

const SESSION_ID = /^[\w-]{1,128}$/;

export const planCheckFile = (runtimeFilePath, sessionId) =>
  SESSION_ID.test(sessionId ?? "")
    ? path.join(path.dirname(runtimeFilePath), `plan-check.${sessionId}.json`)
    : null;

export function tokenPlanCheck(tokenRaw) {
  try {
    const planCheck = JSON.parse(tokenRaw)?.planCheck;
    return Array.isArray(planCheck?.deniedTools) && planCheck.deniedTools.length
      ? {
          deniedTools: planCheck.deniedTools,
          deniedReasons: Array.isArray(planCheck.deniedReasons) ? planCheck.deniedReasons : [],
        }
      : null;
  } catch {
    return null;
  }
}

async function syncPlanChecks(runtimeFilePath, runtimeState, prunedIds) {
  for (const sessionId of prunedIds) {
    const file = planCheckFile(runtimeFilePath, sessionId);
    if (file) await rm(file, { force: true });
  }
  for (const [sessionId, session] of Object.entries(runtimeState.sessions)) {
    const token = typeof session.intentTokenRaw === "string" ? session.intentTokenRaw : "";
    const synced = token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "";
    const file = planCheckFile(runtimeFilePath, sessionId);
    if (!file || (session.planCheckSynced ?? "") === synced) continue;
    const planCheck = token ? tokenPlanCheck(token) : null;
    if (planCheck) await writeJson(file, planCheck);
    else await rm(file, { force: true });
    session.planCheckSynced = synced;
  }
}

export async function saveRuntimeState(runtimeFilePath, runtimeState) {
  const before = snapshots.get(runtimeState) || {
    sessions: {},
    mcpRegistry: {},
    discoveredTools: [],
  };
  await withRuntimeLock(runtimeFilePath, async () => {
    const current = await loadRuntimeState(runtimeFilePath);
    for (const id of new Set([
      ...Object.keys(before.sessions),
      ...Object.keys(runtimeState.sessions),
    ])) {
      const previous = before.sessions[id];
      const next = runtimeState.sessions[id];
      const latest = current.sessions[id];
      if (isDeepStrictEqual(previous, next)) continue;
      // A response from a retired prompt or login cannot restore its token or plan.
      if (previous && (!latest || !sameGenerations(previous, latest))) continue;
      if (!previous && latest && !sameGenerations(next, latest)) continue;
      if (!next) delete current.sessions[id];
      else current.sessions[id] = mergeChanges(previous || {}, next, latest || sessionDefaults());
    }
    current.mcpRegistry = mergeChanges(
      before.mcpRegistry,
      runtimeState.mcpRegistry,
      current.mcpRegistry
    );
    current.discoveredTools = [
      ...new Set([...current.discoveredTools, ...runtimeState.discoveredTools]),
    ];
    const beforePrune = Object.keys(current.sessions);
    pruneSessions(current);
    const pruned = beforePrune.filter((id) => !Object.hasOwn(current.sessions, id));
    await syncPlanChecks(runtimeFilePath, current, pruned);
    await writeJson(runtimeFilePath, current);
  });
  snapshots.set(runtimeState, structuredClone(runtimeState));
}

function mergeChanges(before, next, current) {
  const merged = { ...current };
  for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
    if (isDeepStrictEqual(before[key], next[key])) continue;
    if (!Object.hasOwn(next, key)) delete merged[key];
    else merged[key] = next[key];
  }
  return merged;
}

export function sameGenerations(a, b) {
  return a?.promptGeneration === b?.promptGeneration && a?.authGeneration === b?.authGeneration;
}

export async function updateRuntimeState(file, change) {
  return withRuntimeLock(file, async () => {
    const state = await loadRuntimeState(file);
    const result = await change(state);
    const beforePrune = Object.keys(state.sessions);
    pruneSessions(state);
    const pruned = beforePrune.filter((id) => !Object.hasOwn(state.sessions, id));
    await syncPlanChecks(file, state, pruned);
    if (!isDeepStrictEqual(state, snapshots.get(state))) await writeJson(file, state);
    return result;
  });
}

export const runStateFile = (config) => `${config.runtimeFile}.runs.json`;
const runToolsFile = (config) => `${runStateFile(config)}.tools.jsonl`;
const runStores = new Map();
const RUN_JOURNAL_BYTES = 65_536;

export async function loadRunState(config) {
  if (!config.runReportingEnabled) return { runs: {} };
  return withRuntimeLock(runStateFile(config), async () =>
    structuredClone((await readRunStore(config)).state)
  );
}

async function runFileInfo(file) {
  try {
    return await stat(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function sameRunFile(a, b) {
  return (
    a?.dev === b?.dev &&
    a?.ino === b?.ino &&
    a?.size === b?.size &&
    a?.mtimeMs === b?.mtimeMs &&
    a?.ctimeMs === b?.ctimeMs
  );
}

async function syncRunDirectory(file) {
  const directory = await open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function retainRunFile(file, kind) {
  await rename(file, `${file}.${kind}.${randomUUID()}`);
  await syncRunDirectory(file);
}

function rememberRunStore(config, store) {
  const file = runStateFile(config);
  runStores.delete(file);
  runStores.set(file, store);
  if (runStores.size > 32) runStores.delete(runStores.keys().next().value);
  return store;
}

async function readRunStore(config) {
  const file = runStateFile(config);
  let snapshotInfo = await runFileInfo(file);
  const journalInfo = await runFileInfo(runToolsFile(config));
  const cached = runStores.get(file);
  if (
    cached &&
    sameRunFile(cached.snapshotInfo, snapshotInfo) &&
    sameRunFile(cached.journalInfo, journalInfo)
  )
    return cached;
  let state;
  try {
    state = JSON.parse(await readFile(file, "utf8"));
    if (!state?.runs || typeof state.runs !== "object" || Array.isArray(state.runs))
      throw new SyntaxError("Invalid run state");
  } catch (error) {
    if (error instanceof SyntaxError) {
      await retainRunFile(file, "corrupt");
      await reportRunCaptureFailure(config);
      state = { runs: {} };
      await writeRunState(file, state);
      snapshotInfo = await runFileInfo(file);
    } else {
      if (error.code !== "ENOENT") throw error;
      state = { runs: (await loadRuntimeState(config.runtimeFile)).runs ?? {} };
    }
  }
  const store = { state, snapshotInfo, journalInfo, complete: 0, tail: Buffer.alloc(0) };
  if (journalInfo) {
    const cursor = state.toolJournal;
    const offset =
      cursor?.dev === journalInfo.dev &&
      cursor?.ino === journalInfo.ino &&
      Number.isSafeInteger(cursor.offset) &&
      cursor.offset >= 0 &&
      cursor.offset <= journalInfo.size
        ? cursor.offset
        : 0;
    const handle = await open(runToolsFile(config), "r");
    const journal = Buffer.alloc(journalInfo.size - offset);
    try {
      let read = 0;
      while (read < journal.length) {
        const { bytesRead } = await handle.read(
          journal,
          read,
          journal.length - read,
          offset + read
        );
        if (!bytesRead) throw new Error("Run journal changed while reading");
        read += bytesRead;
      }
    } finally {
      await handle.close();
    }
    const complete = journal.lastIndexOf(10) + 1;
    store.complete = offset + complete;
    store.tail = journal.subarray(complete);
    let corrupt = false;
    for (const line of journal.subarray(0, complete).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line);
        if (!event || typeof event.runId !== "string" || typeof event.id !== "string")
          throw new SyntaxError("Invalid run tool receipt");
        applyRunTool(state, event);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        corrupt = true;
      }
    }
    if (corrupt) {
      await saveRunStore(config, store, "corrupt");
      await reportRunCaptureFailure(config);
    }
  }
  return rememberRunStore(config, store);
}

async function saveRunStore(config, store, kind = "archive") {
  const { state, journalInfo } = store;
  // The snapshot cursor prevents replay if a crash interrupts the retained journal rename.
  if (journalInfo)
    state.toolJournal = { dev: journalInfo.dev, ino: journalInfo.ino, offset: store.complete };
  await writeRunState(runStateFile(config), state);
  if (journalInfo) await retainRunFile(runToolsFile(config), kind);
  store.snapshotInfo = await runFileInfo(runStateFile(config));
  store.journalInfo = null;
  store.complete = 0;
  store.tail = Buffer.alloc(0);
  rememberRunStore(config, store);
}

async function writeRunState(file, state) {
  const tmp = `${file}.tmp.${randomUUID()}`;
  try {
    const handle = await open(tmp, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(tmp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function updateRunState(config, change) {
  if (!config.runReportingEnabled) return;
  try {
    return await withRuntimeLock(runStateFile(config), () => changeRunState(config, change));
  } catch {
    runStores.delete(runStateFile(config));
    await reportRunCaptureFailure(config);
  }
}

async function changeRunState(config, change) {
  const store = await readRunStore(config);
  const state = store.state;
  const before = structuredClone(state);
  const result = await change(state);
  if (!isDeepStrictEqual(before, state) || store.journalInfo?.size >= RUN_JOURNAL_BYTES)
    await saveRunStore(config, store);
  return result;
}

export async function appendRunTool(config, event) {
  if (!config.runReportingEnabled) return;
  try {
    return await withRuntimeLock(runStateFile(config), async () => {
      const store = await readRunStore(config);
      if (!applyRunTool(store.state, event)) {
        if (store.journalInfo?.size >= RUN_JOURNAL_BYTES) await saveRunStore(config, store);
        return;
      }
      const file = runToolsFile(config);
      const handle = await open(file, "a+", PRIVATE_FILE_MODE);
      try {
        if (store.tail.length) {
          // Preserve a torn receipt before repairing the append boundary.
          await writeRunState(`${file}.incomplete.${randomUUID()}`, {
            raw: store.tail.toString("utf8"),
            raw_base64: store.tail.toString("base64"),
          });
          await handle.truncate(store.complete);
        }
        const line = JSON.stringify(event) + "\n";
        await handle.writeFile(line);
        await handle.sync();
        store.complete += Buffer.byteLength(line);
      } finally {
        await handle.close();
      }
      if (!store.journalInfo) await syncRunDirectory(file);
      store.journalInfo = await runFileInfo(file);
      store.tail = Buffer.alloc(0);
      if (store.journalInfo.size >= RUN_JOURNAL_BYTES) await saveRunStore(config, store);
    });
  } catch (error) {
    runStores.delete(runStateFile(config));
    throw error;
  }
}

export function retirePlan(session) {
  Object.assign(session, {
    retirementEpoch: (session.retirementEpoch ?? 0) + 1,
    intentTokenRaw: "",
    allowedActions: [],
    expiresAt: 0,
    countedPlanId: null,
    tokenPlanId: null,
    planHash: null,
    kind: null,
    tokenExpiresAt: null,
    pendingRequest: null,
    unregisteredLocalPlan: null,
    intentRequestFailed: false,
    refreshRetryAt: 0,
    refreshFailures: 0,
  });
  for (const key of [
    "plan",
    "planCaptured",
    "intentExecution",
    "auditedSteps",
    "v2Delegations",
    "apiKeyPrefix",
    "planRequestBody",
    "tokenValiditySeconds",
  ]) {
    delete session[key];
  }
}

export function promptIsOpen(session, now = Date.now()) {
  return Boolean(
    session?.promptId &&
    Number.isFinite(session.promptOpenSince) &&
    Number.isFinite(session.lastActivityAt) &&
    now - session.lastActivityAt < 30 * 60_000
  );
}

export function authFingerprint(config) {
  return sha256Hex(
    JSON.stringify([
      config.apiKey || "",
      config.orgId || "",
      config.userId || "",
      config.backendEndpoint || "",
      config.mode || "",
      config.loggedInAt || "",
      config.loginHistory?.id || "",
    ])
  );
}

export function syncSessionAuth(state, config, sessionId) {
  const fingerprint = authFingerprint(config);
  for (const [id, session] of Object.entries(state.sessions)) {
    if (
      id !== sessionId &&
      session.authBackendEndpoint &&
      session.authBackendEndpoint !== config.backendEndpoint
    )
      continue;
    if (session.authFingerprint && session.authFingerprint !== fingerprint) {
      session.authGeneration += 1;
      retirePlan(session);
    }
    session.authFingerprint = fingerprint;
    session.authBackendEndpoint = config.backendEndpoint;
  }
  return fingerprint;
}

export async function recordHookActivity(input, config, claudeProcessId) {
  const id = typeof input.session_id === "string" ? input.session_id : "";
  if (!id) return;
  return updateRuntimeState(config.runtimeFile, (state) => {
    const fingerprint = syncSessionAuth(state, config, id);
    const previous = state.sessions[id];
    if (previous?.promptOpenSince != null && !promptIsOpen(previous)) {
      previous.promptOpenSince = null;
      if (previous.pendingRequest?.headers?.["X-ArmorIQ-Plan-Kind"] === "refresh")
        previous.pendingRequest = null;
    }
    const session = upsertSession(state, id, {
      authFingerprint: fingerprint,
      authBackendEndpoint: config.backendEndpoint,
      lastActivityAt: Date.now(),
      ...(Number.isSafeInteger(claudeProcessId) && claudeProcessId > 1 ? { claudeProcessId } : {}),
    });
    if (!input.agent_id && !input.parent_session_id && !input.is_subagent && session.promptId)
      state.activeSessionId = id;
    return { promptGeneration: session.promptGeneration, authGeneration: session.authGeneration };
  });
}

export async function startPrompt(input, config) {
  if (input.agent_id || input.parent_session_id || input.is_subagent) return;
  let releaseRun;
  if (config.runReportingEnabled) {
    try {
      // Waiting for the run lock with the session lock held can make tool enforcement time out.
      releaseRun = await acquireRuntimeLock(runStateFile(config));
    } catch {
      await reportRunCaptureFailure(config);
    }
  }
  try {
    await updateRuntimeState(config.runtimeFile, async (state) => {
      const fingerprint = syncSessionAuth(state, config, input.session_id);
      const session = upsertSession(state, input.session_id, { authFingerprint: fingerprint });
      session.authBackendEndpoint = config.backendEndpoint;
      state.activeSessionId = input.session_id;
      const now = Date.now();
      const hash = sha256Hex(input.prompt);
      const age = now - (session.promptIdentityAt ?? 0);
      if (session.promptIdentityHash === hash && age >= 0 && age <= 5000) return;
      const previous = session.promptId;
      retirePlan(session);
      Object.assign(session, {
        promptId: randomUUID(),
        promptGeneration: session.promptGeneration + 1,
        retirementEpoch: 0,
        promptOpenSince: now,
        lastActivityAt: now,
        promptIdentityHash: hash,
        promptIdentityAt: now,
        lastPrompt: input.prompt,
        lastPromptAt: nowEpochSeconds(),
      });
      // Publishing the prompt first would let a crash lose its only run report.
      if (releaseRun) {
        try {
          await changeRunState(config, (runs) => {
            closeRun(runs, previous, "next_prompt", now);
            openRun(
              { ...runs, sessions: { [input.session_id]: session } },
              input.session_id,
              config,
              now
            );
          });
        } catch {
          runStores.delete(runStateFile(config));
          await reportRunCaptureFailure(config);
        }
      }
    });
  } finally {
    if (releaseRun) {
      try {
        await releaseRun();
      } catch {
        await reportRunCaptureFailure(config);
      }
    }
  }
}

export function upsertDiscoveredTool(runtimeState, toolName) {
  if (!toolName || typeof toolName !== "string") return;
  const name = toolName.trim();
  if (!name) return;
  if (!Array.isArray(runtimeState.discoveredTools)) {
    runtimeState.discoveredTools = [];
  }
  const normalized = name.toLowerCase();
  const existing = runtimeState.discoveredTools.map((t) => t.toLowerCase());
  if (!existing.includes(normalized)) {
    runtimeState.discoveredTools.push(name);
  }
}

export function getDiscoveredTools(runtimeState) {
  return Array.isArray(runtimeState?.discoveredTools) ? runtimeState.discoveredTools : [];
}

export function appendTrustOp(runtimeState, sessionId, op) {
  if (!sessionId || !op || typeof op !== "object") return;
  const session = getSession(runtimeState, sessionId);
  if (!session) return;
  if (!Array.isArray(session.trustOpsLog)) {
    session.trustOpsLog = [];
  }
  const entry = {
    ts: nowEpochSeconds(),
    operation: typeof op.operation === "string" ? op.operation : "Unknown",
    trustId: typeof op.trustId === "string" ? op.trustId : undefined,
    fromHash: typeof op.fromHash === "string" ? op.fromHash : undefined,
    toHash: typeof op.toHash === "string" ? op.toHash : undefined,
    reason: typeof op.reason === "string" ? op.reason : undefined,
    ok: op.ok !== false,
  };
  session.trustOpsLog.push(entry);
  session.updatedAt = entry.ts;
  return entry;
}

export function getTrustOps(runtimeState, sessionId) {
  const session = getSession(runtimeState, sessionId);
  return Array.isArray(session?.trustOpsLog) ? session.trustOpsLog : [];
}
