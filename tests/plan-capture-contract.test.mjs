import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as intent from "../scripts/lib/intent.mjs";
import { createAuditWal, loginTag } from "../scripts/lib/audit-wal.mjs";
import { loadConfig } from "../scripts/lib/config.mjs";
import { dispatchViaDaemon } from "../scripts/lib/daemon-client.mjs";
import { handlePreToolUse } from "../scripts/lib/engine.mjs";
import { normalizeIntentPlan } from "../scripts/lib/intent-schema.mjs";
import {
  loadRuntimeState,
  recordHookActivity,
  retirePlan,
  startPrompt,
  syncSessionAuth,
  updateRuntimeState,
} from "../scripts/lib/runtime-state.mjs";
import {
  mockTokenBackend as wire,
  startBackend,
  startHookSession,
  startPolicyMcp,
} from "./helpers/hook-session.mjs";
import { loadConfigWithLogins, withHome, writeLoginProfiles } from "./helpers/login-profile.mjs";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/plan-capture-v1.json", import.meta.url))
);
const plan = normalizeIntentPlan({ goal: "Read the source", steps: [{ action: "Read" }] });
const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const now = 1_800_000_000_000;

function issued(id = firstId, kind = "new") {
  return {
    success: true,
    plan_id: id,
    ...(kind ? { kind } : {}),
    intent_reference: "intent-test",
    plan_hash: "signed-plan-hash",
    token: { issued_at: now / 1000, expires_at: now / 1000 + 3600, signature: "signed" },
    step_proofs: [],
  };
}

async function session(t, patch = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "aq-contract-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = {
    ...loadConfigWithLogins([], { CLAUDE_PLUGIN_DATA: dataDir }),
    apiKey: "ak_test_contract000000000000000000",
    userId: "contract-user",
    backendEndpoint: "http://127.0.0.1:1",
    csrgEndpoint: "http://127.0.0.1:1",
    mode: "enforce",
    ...patch,
  };
  const sessionId = randomUUID();
  await recordHookActivity({ session_id: sessionId }, config, process.ppid);
  await startPrompt({ session_id: sessionId, prompt: "Read the source" }, config);
  return {
    config,
    sessionId,
    state: async () => (await loadRuntimeState(config.runtimeFile)).sessions[sessionId],
  };
}

async function healthEvents(config) {
  const wal = createAuditWal({
    dataDir: config.dataDir,
    login: loginTag(config.backendEndpoint, config.apiKey),
    stream: "health",
  });
  return (await wal.readPending()).map(({ row }) => row);
}

// regression: #0012
test("a failed health append preserves the backend refusal and settles the registration", async (t) => {
  for (const [status, data, headers, unconfirmed] of [
    [422, { message: "org_required" }, {}, false],
    [503, { message: "save unavailable" }, { "retry-after": "60" }, true],
    [200, { success: true }, {}, true],
  ]) {
    await t.test(String(status), async (t) => {
      const s = await session(t);
      await writeFile(path.join(s.config.dataDir, "health"), "storage unavailable");
      wire(t, async () => [status, data, headers]);
      const result = await intent.registerIntentPlan(s.config, plan);
      assert.equal(result.isError, true);
      assert.doesNotMatch(result.content[0].text, /ENOTDIR|EEXIST|storage|directory/);
      if (status !== 200) assert.match(result.content[0].text, new RegExp(data.message));
      const pending = (await s.state()).pendingRequest;
      assert.equal(pending?.unconfirmed ?? false, unconfirmed);
      if (!unconfirmed) assert.equal(pending, null);
    });
  }
});

for (const [group, symbol, input] of [
  ["canonicalJson", "canonicalJson", "input"],
  ["planHash", "planHash", "plan"],
  ["idempotencyKey", "idempotencyKey", "input"],
]) {
  test(`all ${group} fixture vectors`, async () => {
    const contract = await import("../scripts/lib/plan-request.mjs");
    for (const vector of fixtures[group]) {
      assert.equal(contract[symbol](vector[input]), vector.expected, vector.name);
      if (group === "idempotencyKey" && vector.input.kind === "refresh")
        assert.equal(
          contract.idempotencyKey({ ...vector.input, epoch: 2 }),
          vector.expected,
          vector.name
        );
    }
  });
}

test("new, usable duplicate, revision, expired duplicate, and next prompt use the contract", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t);
  const requests = wire(t, async (request, attempt) => {
    const saved = (await s.state()).pendingRequest;
    assert.equal(saved.key, request.headers["Idempotency-Key"]);
    assert.deepEqual(saved.body, request.body);
    assert.equal(saved.headers["X-ArmorIQ-Plan-Kind"], request.headers["X-ArmorIQ-Plan-Kind"]);
    return [
      200,
      issued(attempt === 1 ? firstId : secondId, request.headers["X-ArmorIQ-Plan-Kind"]),
    ];
  });
  const register = (p = plan) => intent.registerIntentPlan(s.config, p);
  const first = await register();
  assert.equal(first.isError, undefined);
  assert.equal(
    first.content[0].text,
    `Intent registered: plan ${firstId} (new), 1 steps. Token valid until 2027-01-15T09:00:00.000Z.`
  );
  assert.equal((await register()).content[0].text, first.content[0].text);
  assert.equal(requests.length, 1);
  const revised = { ...plan, metadata: { ...plan.metadata, goal: "Review more source" } };
  const revision = await register(revised);
  assert.match(revision.content[0].text, new RegExp(`plan ${secondId} \\(revision\\)`));
  assert.equal(requests[1].headers["X-ArmorIQ-Parent-Plan-Id"], firstId);
  assert.equal(
    requests[1].headers["X-ArmorIQ-Prompt-Id"],
    requests[0].headers["X-ArmorIQ-Prompt-Id"]
  );
  assert.equal(requests[0].headers["X-ArmorIQ-Plan-Kind"], "new");
  assert.equal(requests[0].headers["X-ArmorIQ-Parent-Plan-Id"], undefined);
  assert.equal(requests[0].body.context_id, s.sessionId);
  assert.equal(requests[0].headers[fixtures.headers.kind], fixtures.kinds.wire[0]);
  assert.equal(requests[1].headers[fixtures.headers.kind], fixtures.kinds.wire[1]);
  assert.equal(requests[1].headers[fixtures.headers.parentPlanId], firstId);
  assert.equal(requests[0].headers[fixtures.headers.promptId], (await s.state()).promptId);
  assert.match(requests[0].headers[fixtures.headers.idempotencyKey], /^pcc1:/);
  const identity = fixtures.identity.find((row) => row.plugin === "ArmorClaude");
  assert.equal(requests[0].body.agent_id, identity.agentId);
  assert.ok(
    identity.clientHeaderPattern
      .split(" or ")
      .some(
        (pattern) =>
          requests[0].headers["X-ArmorIQ-Client"] ===
          pattern.replace("<v>", s.config.client.version)
      )
  );
  await updateRuntimeState(s.config.runtimeFile, (state) => {
    state.sessions[s.sessionId].tokenExpiresAt = new Date(now - 1).toISOString();
    state.sessions[s.sessionId].expiresAt = now / 1000 - 1;
  });
  await register(revised);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].headers["X-ArmorIQ-Plan-Kind"], "revision");
  await startPrompt({ session_id: s.sessionId, prompt: "another prompt" }, s.config);
  await register();
  assert.equal(requests[3].headers["X-ArmorIQ-Plan-Kind"], "new");
  assert.notEqual(
    requests[3].headers["X-ArmorIQ-Prompt-Id"],
    requests[0].headers["X-ArmorIQ-Prompt-Id"]
  );
});

// regression: #0007
test("retiring a plan gets a new plan from a backend that replays by key", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t);
  const replies = new Map();
  const requests = wire(t, async (request) => {
    const key = request.headers["Idempotency-Key"];
    if (!replies.has(key)) replies.set(key, issued(randomUUID()));
    return [200, replies.get(key)];
  });
  const promptId = (await s.state()).promptId;
  const registeredIds = new Set();
  for (let epoch = 0; epoch <= 2; epoch++) {
    if (epoch > 0)
      await updateRuntimeState(s.config.runtimeFile, (state) =>
        retirePlan(state.sessions[s.sessionId])
      );
    const result = await intent.registerIntentPlan(s.config, plan);
    assert.notEqual(result.isError, true, result.content[0].text);
    const current = await s.state();
    assert.equal(current.promptId, promptId);
    assert.equal(registeredIds.has(current.countedPlanId), false, "retired plan was replayed");
    registeredIds.add(current.countedPlanId);
  }
  assert.equal(requests.length, 3);
  assert.equal(new Set(requests.map((request) => request.headers["Idempotency-Key"])).size, 3);
  await startPrompt({ session_id: s.sessionId, prompt: "another prompt" }, s.config);
  await intent.registerIntentPlan(s.config, plan);
  const { idempotencyKey, planHash } = await import("../scripts/lib/plan-request.mjs");
  assert.equal(
    requests[3].headers["Idempotency-Key"],
    idempotencyKey({ kind: "new", promptId: (await s.state()).promptId, planHash: planHash(plan) })
  );
});

// regression: #0007
test("confirmed refusals are errors and never register a local token", async (t) => {
  await t.test("missing prompt", async (t) => {
    const s = await session(t);
    const requests = wire(t, async () => [200, issued()]);
    await updateRuntimeState(s.config.runtimeFile, (state) => {
      state.sessions[s.sessionId].promptId = null;
    });
    await assert.rejects(
      intent.requestIntent(s.config, { session_id: s.sessionId, plan, prompt: "keep this local" }),
      /root prompt/
    );
    assert.equal(requests.length, 0);
  });
  for (const [status, error] of [
    [400, "invalid_prompt_id"],
    [401, "unauthorized"],
    [403, "blocked"],
    [409, "other_conflict"],
    [422, "org_required"],
  ]) {
    await t.test(String(status), async (t) => {
      const s = await session(t);
      const requests = wire(t, async () => [status, { error, message: error }]);
      const result = await intent.registerIntentPlan(s.config, plan);
      assert.equal(result.isError, true);
      assert.equal(result.content[0].text, `Plan not registered: ${error}.`);
      assert.equal(requests.length, 1);
      assert.equal((await s.state()).countedPlanId, null);
      assert.equal((await s.state()).pendingRequest, null);
      assert.equal((await s.state()).intentTokenRaw ?? "", "");
      const events = await healthEvents(s.config);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "plan_request_failed");
      assert.equal(events[0].reason_code, "rejected");
      assert.equal(events[0].count, 1);
    });
  }
});

test("retryable responses honour both Retry-After forms and reuse the saved wire request", async (t) => {
  for (const [status, error, retryAfter] of [
    [429, "rate_limited", "2"],
    [500, "server_error", new Date(now + 2000).toUTCString()],
    [409, "request_in_progress", "2"],
    [503, "unavailable", ""],
  ]) {
    await t.test(String(status), async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
      const s = await session(t);
      const waiting = Promise.withResolvers();
      const fakeTimeout = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (...args) => {
        const timer = fakeTimeout(...args);
        waiting.resolve(args[1]);
        return timer;
      });
      const requests = wire(t, async (_, attempt) => {
        if (attempt === 1) {
          return [status, { error, message: error }, { "retry-after": retryAfter }];
        }
        assert.equal(Date.now() - now, retryAfter === "" ? 1000 : 2000);
        return [200, issued()];
      });
      const registering = intent.registerIntentPlan(s.config, plan);
      const delay = await waiting.promise;
      t.mock.timers.tick(retryAfter === "" ? 999 : 1999);
      assert.equal(requests.length, 1);
      t.mock.timers.tick(1);
      const result = await registering;
      assert.equal(delay, retryAfter === "" ? 1000 : 2000);
      assert.notEqual(result.isError, true);
      assert.deepEqual(requests[1].body, requests[0].body);
      assert.deepEqual(requests[1].headers, requests[0].headers);
      assert.deepEqual(await healthEvents(s.config), []);
    });
  }
});

test("exhausted logical requests report once after all attempts with the final reason", async (t) => {
  for (const [status, error, code, expected] of [
    [503, "plan_not_saved", null, "server_error"],
    [409, "request_in_progress", null, "request_in_progress"],
    [0, "socket timeout", "ETIMEDOUT", "timeout"],
  ]) {
    await t.test(expected, async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
      const s = await session(t);
      const waiting = Promise.withResolvers();
      const fakeTimeout = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (...args) => {
        const timer = fakeTimeout(...args);
        waiting.resolve();
        return timer;
      });
      const requests = wire(t, async (_, attempt) => {
        if (attempt === 2) t.mock.timers.tick(40_000);
        if (code) throw Object.assign(new Error(error), { code });
        return [status, { error }, { "retry-after": "1" }];
      });
      const registering = intent.registerIntentPlan(s.config, plan);
      await waiting.promise;
      assert.deepEqual(await healthEvents(s.config), []);
      t.mock.timers.tick(1000);
      assert.equal((await registering).isError, true);
      assert.equal(requests.length, 2);
      const events = await healthEvents(s.config);
      assert.equal(events.length, 1);
      assert.equal(events[0].reason_code, expected);
      assert.equal(events[0].count, 1);
    });
  }
});

test("an uncertain request is retried with its descriptor after the handler is rerun", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t);
  const requests = wire(t, async (_, attempt) => {
    if (attempt === 1) {
      t.mock.timers.tick(40_000);
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    }
    return [200, issued()];
  });
  const first = await intent.registerIntentPlan(s.config, plan);
  assert.equal(first.isError, true);
  assert.equal(
    first.content[0].text,
    "Plan registration not confirmed: connection reset. It will be retried with the same request id."
  );
  const saved = (await s.state()).pendingRequest;
  assert.equal(saved.key, requests[0].headers["Idempotency-Key"]);
  const changed = await intent.registerIntentPlan(s.config, {
    ...plan,
    metadata: { goal: "different" },
  });
  assert.match(changed.content[0].text, /resend the identical pending plan/);
  const events = await healthEvents(s.config);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason_code, "network");
  t.mock.timers.tick(1000);
  const next = await intent.registerIntentPlan(s.config, plan);
  assert.notEqual(next.isError, true);
  assert.deepEqual(requests[1].body, saved.body);
  assert.deepEqual(requests[1].headers, requests[0].headers);
  assert.equal((await s.state()).countedPlanId, firstId);
  assert.deepEqual(await healthEvents(s.config), events);
});

test("a handler rerun preserves a Retry-After beyond the first deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t);
  const requests = wire(t, async (_, attempt) =>
    attempt === 1 ? [429, { error: "rate_limited" }, { "retry-after": "60" }] : [200, issued()]
  );
  assert.equal((await intent.registerIntentPlan(s.config, plan)).isError, true);
  assert.equal((await intent.registerIntentPlan(s.config, plan)).isError, true);
  assert.equal(requests.length, 1);
  const events = await healthEvents(s.config);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason_code, "rate_limited");
  t.mock.timers.tick(60_000);
  assert.notEqual((await intent.registerIntentPlan(s.config, plan)).isError, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].headers, requests[0].headers);
  assert.deepEqual(await healthEvents(s.config), events);
});

test("a daemon fallback shares the in flight descriptor and its logical deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const requests = wire(t, async (_, attempt) => {
    if (attempt === 1) {
      started.resolve();
      await release.promise;
    }
    return [200, { ...issued(), idempotent_replay: attempt === 2 }];
  });
  const daemon = intent.registerIntentPlan(s.config, plan);
  await started.promise;
  const saved = (await s.state()).pendingRequest;
  t.mock.timers.tick(10_000);
  const fallback = await intent.registerIntentPlan(s.config, plan);
  release.resolve();
  const original = await daemon;
  assert.notEqual(original.isError, true, original.content[0].text);
  assert.notEqual(fallback.isError, true, fallback.content[0].text);
  assert.equal(original.content[0].text, fallback.content[0].text);
  assert.deepEqual(requests[1].body, saved.body);
  assert.deepEqual(requests[1].headers, requests[0].headers);
  assert.ok(requests[1].timeout <= 30_000);
});

test("late prompt and auth responses cannot install a registration", async (t) => {
  for (const change of ["prompt", "auth"]) {
    await t.test(change, async (t) => {
      const s = await session(t);
      wire(t, async () => {
        if (change === "prompt")
          await startPrompt({ session_id: s.sessionId, prompt: "next" }, s.config);
        else
          await updateRuntimeState(s.config.runtimeFile, (state) =>
            syncSessionAuth(state, { ...s.config, apiKey: "another-key" })
          );
        return [200, issued()];
      });
      const result = await intent.registerIntentPlan(s.config, plan);
      assert.equal(result.isError, true);
      assert.equal(
        result.content[0].text,
        "Plan not registered: plan retired before registration completed."
      );
      assert.equal((await s.state()).countedPlanId, null);
      assert.equal((await s.state()).intentTokenRaw, "");
      assert.deepEqual(await healthEvents(s.config), []);
    });
  }
});

test("a logged out registration is an explicit local record and sends nothing", async (t) => {
  const s = await session(t, { apiKey: "" });
  const requests = wire(t, async () => {
    throw new Error("must not send");
  });
  const result = await intent.registerIntentPlan(s.config, plan);
  assert.equal(result.content[0].text, "Plan recorded locally, not registered (logged_out).");
  assert.notEqual(result.isError, true);
  assert.equal(requests.length, 0);
  assert.equal((await s.state()).unregisteredLocalPlan.reason, "logged_out");
  assert.deepEqual((await s.state()).unregisteredLocalPlan.plan, plan);
  assert.equal((await s.state()).countedPlanId, null);
});

test("a signed in monitor registration and reanchor send the plan as Enforce does", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t, { mode: "monitor" });
  const requests = wire(t, async (request, attempt) => [
    200,
    issued(attempt === 1 ? firstId : secondId, request.headers["X-ArmorIQ-Plan-Kind"]),
  ]);
  const registered = await intent.registerIntentPlan(s.config, plan);
  assert.equal(
    registered.content[0].text,
    `Intent registered: plan ${firstId} (new), 1 steps. Token valid until 2027-01-15T09:00:00.000Z.`
  );
  const reanchored = await intent.registerIntentPlan(s.config, plan, { forceRevision: true });
  assert.match(reanchored.content[0].text, new RegExp(`^Intent registered: plan ${secondId} `));
  const state = await s.state();
  assert.deepEqual(
    requests.map(({ headers }) => [
      headers["X-ArmorIQ-Plan-Kind"],
      headers["X-ArmorIQ-Prompt-Id"],
      headers["X-ArmorIQ-Parent-Plan-Id"],
    ]),
    [
      ["new", state.promptId, undefined],
      ["revision", state.promptId, firstId],
    ]
  );
  assert.match(requests[0].headers["Idempotency-Key"], /^pcc1:[0-9a-f]{64}$/);
  assert.equal(state.countedPlanId, secondId);
  assert.equal(state.unregisteredLocalPlan, null);
});

test("older backends still register and log the absent kind once", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t);
  const logs = [];
  t.mock.method(process.stderr, "write", (text) => {
    logs.push(String(text));
    return true;
  });
  wire(t, async () => [200, issued(firstId, null)]);
  assert.notEqual((await intent.registerIntentPlan(s.config, plan)).isError, true);
  await intent.registerIntentPlan(s.config, { ...plan, metadata: { goal: "more" } });
  assert.equal(logs.filter((line) => /backend.*kind/i.test(line)).length, 1);
});

test("reanchor requires a current plan and registers an identical plan as a revision", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now });
  const s = await session(t);
  const requests = wire(t, async (request, attempt) => [
    attempt === 3 ? 429 : 200,
    attempt === 3
      ? { error: "rate_limited" }
      : issued(attempt === 1 ? firstId : secondId, request.headers["X-ArmorIQ-Plan-Kind"]),
    attempt === 3 ? { "retry-after": "60" } : {},
  ]);
  const absent = await intent.registerIntentPlan(s.config, plan, { forceRevision: true });
  assert.equal(absent.isError, true);
  assert.equal(
    absent.content[0].text,
    "Plan not registered: no current plan in this prompt to reanchor."
  );
  assert.equal(requests.length, 0);
  await intent.registerIntentPlan(s.config, plan);
  const revision = await intent.registerIntentPlan(s.config, plan, { forceRevision: true });
  assert.notEqual(revision.isError, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers["X-ArmorIQ-Plan-Kind"], "revision");
  assert.equal(requests[1].headers["X-ArmorIQ-Parent-Plan-Id"], firstId);
  await updateRuntimeState(s.config.runtimeFile, (state) => {
    state.sessions[s.sessionId].tokenExpiresAt = new Date(Date.now() - 1).toISOString();
    state.sessions[s.sessionId].expiresAt = Date.now() / 1000 - 1;
  });
  await intent.refreshIntent(s.config, s.sessionId);
  assert.equal((await s.state()).pendingRequest.headers["X-ArmorIQ-Plan-Kind"], "refresh");
  t.mock.timers.tick(60_000);
  const afterRefresh = await intent.registerIntentPlan(s.config, plan, { forceRevision: true });
  assert.notEqual(afterRefresh.isError, true, afterRefresh.content[0].text);
  assert.equal(requests[3].headers["X-ArmorIQ-Plan-Kind"], "refresh");
  assert.equal(requests[4].headers["X-ArmorIQ-Plan-Kind"], "revision");
});

test("shared validity takes precedence and invalid values stop configuration", () => {
  for (const value of ["180", "3600", "240"]) {
    assert.equal(
      loadConfig({
        ARMORIQ_INTENT_VALIDITY_SECONDS: value,
      }).validitySeconds,
      Number(value)
    );
  }
  assert.equal(loadConfig({}).validitySeconds, 3600);
  for (const value of ["", "bad", "179", "3601", "Infinity", "180.5"]) {
    assert.throws(
      () => loadConfig({ ARMORIQ_INTENT_VALIDITY_SECONDS: value }),
      /ARMORIQ_INTENT_VALIDITY_SECONDS/
    );
  }
});

// regression: #0007
test("MCP revoke retires the local plan and registers the same prompt under a fresh epoch", async (t) => {
  const s = await session(t);
  const home = await mkdtemp(path.join(os.tmpdir(), "aq-revoke-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  writeLoginProfiles(home, [{ backend: s.config.backendEndpoint, apiKey: s.config.apiKey }]);
  const requestsFile = path.join(home, "requests.jsonl");
  const preload = path.join(home, "sdk-http.mjs");
  await writeFile(
    preload,
    `
    import sdk from ${JSON.stringify(import.meta.resolve("@armoriq/sdk"))};
    import { appendFileSync } from "node:fs";
    const create = sdk.ArmorIQClient.prototype.createHttpClient;
    const responses = new Map();
    sdk.ArmorIQClient.prototype.createHttpClient = function (...args) {
      const client = create.apply(this, args);
      client.defaults.adapter = async request => {
        const headers = request.headers.toJSON();
        appendFileSync(${JSON.stringify(requestsFile)}, JSON.stringify({ url: request.url, headers }) + "\\n");
        let data;
        if (request.url.endsWith("/iap/sdk/token")) {
          const key = headers["Idempotency-Key"];
          if (!responses.has(key)) responses.set(key, responses.size === 0 ? ${JSON.stringify(issued(firstId))} : ${JSON.stringify(issued(secondId))});
          data = responses.get(key);
        } else if (request.url.endsWith("/iap/trust/revoke")) data = { trustId: "revoked-plan" };
        else throw new Error("Unexpected SDK request: " + request.url);
        return { status: 200, data, headers: {}, config: request, statusText: "OK" };
      };
      return client;
    };
  `
  );
  const client = await startPolicyMcp(
    t,
    {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_PLUGIN_DATA: s.config.dataDir,
      ARMORIQ_ENV: "local",
      ARMORIQ_BACKEND_URL: s.config.backendEndpoint,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${preload}`].filter(Boolean).join(" "),
    },
    s.sessionId
  );
  const args = {
    name: "register_intent_plan",
    arguments: { goal: "Read the source", steps: [{ action: "Read" }] },
  };
  const first = await client.callTool(args);
  assert.notEqual(first.isError, true, first.content[0].text);
  const before = await s.state();
  const revoked = await client.callTool({ name: "trust_revoke", arguments: { reason: "stop" } });
  assert.match(revoked.content[0].text, /^Token revoked\./);
  const retired = await s.state();
  assert.equal(retired.promptId, before.promptId);
  assert.equal(retired.retirementEpoch, before.retirementEpoch + 1);
  assert.equal(retired.countedPlanId, null);
  assert.equal(retired.pendingRequest, null);
  assert.equal(retired.intentTokenRaw, "");
  const registered = await client.callTool(args);
  assert.notEqual(registered.isError, true, registered.content[0].text);
  assert.equal((await s.state()).countedPlanId, secondId);
  const requests = (await readFile(requestsFile, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter(({ url }) => url.endsWith("/iap/sdk/token"));
  assert.equal(requests.length, 2);
  assert.notEqual(requests[1].headers["Idempotency-Key"], requests[0].headers["Idempotency-Key"]);
  assert.equal(requests[1].headers["X-ArmorIQ-Plan-Kind"], "new");
  assert.equal(requests[1].headers["X-ArmorIQ-Prompt-Id"], before.promptId);
});

test("MCP registration exposes confirmed ids and errors from the mock backend", async (t) => {
  let count = 0;
  const backend = await startBackend({
    "POST /iap/sdk/token": (_, req) =>
      ++count === 1
        ? [422, { message: "org_required", error: "org_required" }]
        : [200, issued(count === 2 ? firstId : secondId, req.headers["x-armoriq-plan-kind"])],
    "POST /iap/trust/reanchor": () => [422, { message: "reanchor rejected" }],
  });
  const s = await startHookSession(t, backend);
  await s.hook({ hook_event_name: "UserPromptSubmit", prompt: "Read source" });
  const client = await startPolicyMcp(t, s.env, s.sessionId);
  const args = {
    name: "register_intent_plan",
    arguments: { goal: "Read source", steps: [{ action: "Read" }] },
  };
  const failure = await client.callTool(args);
  assert.equal(failure.isError, true);
  assert.equal(failure.content[0].text, "Plan not registered: org_required.");
  const success = await client.callTool(args);
  assert.match(
    success.content[0].text,
    new RegExp(`Intent registered: plan ${firstId} \\(new\\), 1 steps\\. Token valid until `)
  );
  assert.notEqual(success.isError, true);
  const sent = backend.requests.filter((r) => r.route === "POST /iap/sdk/token");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].headers["x-armoriq-plan-kind"], "new");
  assert.equal((await client.callTool(args)).content[0].text, success.content[0].text);
  assert.equal(backend.requests.filter((r) => r.route === "POST /iap/sdk/token").length, 2);
  const reanchor = await client.callTool({
    name: "trust_reanchor",
    arguments: { updatedPlan: args.arguments, reason: "Review the plan again" },
  });
  assert.notEqual(reanchor.isError, true);
  assert.match(reanchor.content[0].text, new RegExp(`plan ${secondId} \\(revision\\)`));
  const state = (await loadRuntimeState(path.join(s.dataDir, "runtime.json"))).sessions[
    s.sessionId
  ];
  assert.equal(state.countedPlanId, secondId);
  assert.equal(state.trustOpsLog.at(-1).ok, false);
  const revision = backend.requests.filter((r) => r.route === "POST /iap/sdk/token").at(-1);
  assert.equal(revision.headers["x-armoriq-parent-plan-id"], firstId);
});

// regression: #0007
test("the daemon refresh timeout and in process fallback resend one wire descriptor", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let attempts = 0;
  t.after(() => release.resolve());
  const backend = await startBackend({
    "POST /iap/sdk/token": async (_, req) => {
      if (++attempts === 2) {
        started.resolve();
        await release.promise;
      }
      return [
        200,
        issued(
          req.headers["x-armoriq-plan-kind"] === "refresh" ? secondId : firstId,
          req.headers["x-armoriq-plan-kind"]
        ),
      ];
    },
  });
  const s = await startHookSession(t, backend);
  await s.hook({ hook_event_name: "UserPromptSubmit", prompt: "Read source" });
  const config = withHome(s.env.HOME, () => loadConfig(s.env));
  const state = async () => (await loadRuntimeState(config.runtimeFile)).sessions[s.sessionId];
  await recordHookActivity({ session_id: s.sessionId }, config, process.ppid);
  const registered = await intent.registerIntentPlan(
    config,
    normalizeIntentPlan({ goal: "write source", steps: [{ action: "Write" }] })
  );
  assert.notEqual(registered.isError, true, registered.content[0].text);
  await updateRuntimeState(config.runtimeFile, (runtime) => {
    runtime.sessions[s.sessionId].expiresAt = Date.now() / 1000 - 1;
    runtime.sessions[s.sessionId].tokenExpiresAt = new Date(Date.now() - 1000).toISOString();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = {
    session_id: s.sessionId,
    tool_name: "Write",
    tool_input: { file_path: "source.mjs", content: "export const value = 1;" },
  };
  const daemon = dispatchViaDaemon({ event: "PreToolUse", input, config });
  const timedOut = assert.rejects(daemon, /daemon reply timeout/);
  await started.promise;
  const saved = (await state()).pendingRequest;
  assert.ok(saved);
  t.mock.timers.tick(10_000);
  await timedOut;
  assert.equal(await handlePreToolUse(input, config), null);
  release.resolve();
  const requests = backend.requests.filter((r) => r.route === "POST /iap/sdk/token");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].body, saved.body);
  assert.equal(requests[1].headers["idempotency-key"], saved.key);
  assert.equal(requests[1].headers["x-armoriq-plan-kind"], "refresh");
  assert.deepEqual(requests[2].body, requests[1].body);
  assert.equal(requests[2].headers["idempotency-key"], requests[1].headers["idempotency-key"]);
  assert.equal((await state()).countedPlanId, firstId);
  assert.equal((await state()).pendingRequest, null);
  await recordHookActivity(input, config, process.ppid);
  const reply = await intent.registerIntentPlan(config, saved.body.plan);
  assert.notEqual(reply.isError, true);
  assert.equal(
    reply.content[0].text,
    `Intent registered: plan ${firstId} (new), 1 steps. Token valid until 2027-01-15T09:00:00.000Z.`
  );
  assert.equal(backend.requests.filter((r) => r.route === "POST /iap/sdk/token").length, 3);
});
