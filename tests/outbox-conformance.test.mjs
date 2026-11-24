import { after, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as outbox from "../scripts/lib/audit-wal.mjs";
import { defineOutboxConformance } from "./helpers/outbox-conformance.template.mjs";

const dirs = [];
const { createAuditWal, loginTag } = outbox;
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function makeAdapter(options, shared) {
  if (!shared) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "armor-outbox-"));
    dirs.push(dataDir);
    shared = { dataDir, current: options.login, bindings: new Map(), fault: null };
  }
  const open = (login) => {
    const tag = loginTag(login.backend, login.keyId);
    shared.bindings.set(tag, { backend: login.backend, keyId: login.keyId });
    return createAuditWal({
      ...options,
      dataDir: shared.dataDir,
      login: tag,
      binding: shared.bindings.get(tag),
      beforeCommit(point) {
        if (shared.fault !== point) return;
        shared.fault = null;
        throw new Error(`injected ${point} storage failure`);
      },
    });
  };
  const all = () => [...shared.bindings.values()].map(open);
  return {
    async append(row, { fallback = false, loggedOut = false } = {}) {
      if (loggedOut) return;
      if (!shared.current) return outbox.recordCaptureFailure(shared.dataDir, row.decision_code);
      await open(shared.current).appendLine(row, { fallback });
    },
    async drain(send, { probe } = {}) {
      if (!shared.current || shared.current.available === false) return;
      await open(shared.current).drain(send, { resolveLogin: () => shared.current, probe });
    },
    async readPending() {
      return (await Promise.all(all().map((wal) => wal.readPending()))).flat();
    },
    async readDeadLetters() {
      return (await Promise.all(all().map((wal) => wal.readDeadLetters()))).flat();
    },
    async status() {
      const { auditStatus } = await import("../scripts/lib/audit-wal.mjs");
      return auditStatus(shared.dataDir, () => shared.current);
    },
    async switchLogin(login) {
      shared.current = login;
      if (login && login.available !== false) await open(login).restoreLogin();
    },
    async authenticationSucceeded(login) {
      for (const wal of all()) await wal.authenticationSucceeded(login);
    },
    async failNext(point) {
      shared.fault = point;
    },
    restart: () => makeAdapter(options, shared),
    secondDrainer: () => makeAdapter(options, shared),
  };
}

defineOutboxConformance({ describe, it, makeAdapter });
