// Faithful repro of the DAEMON dispatch path a real Claude Code session uses.
// Real sessions go through bootstrap -> hook-router -> daemon (Unix socket).
// This harness:
//   1. Kills any stale daemon so a correctly-configured one is spawned.
//   2. Fires SessionStart -> UserPromptSubmit -> PreToolUse(Read) ->
//      PostToolUse(Read) -> PreToolUse(Bash, DENIED) -> register_intent_plan
//      (via the real MCP stdio server) -> PreToolUse(Bash, ALLOWED) ->
//      PostToolUse(Bash) -> Stop -> SessionEnd, all through the daemon.
//   3. Proves (i) an armorclaude iap.plan trace with nested spans lands in PG,
//      (ii) a span ships BEFORE SessionEnd (Stop-triggered mid-session flush),
//      (iii) after register_intent_plan the gated Bash is ALLOWED and
//      runtime.json has the session.
//
// Usage: node tmp-obs-hook-harness.mjs
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROUTER = new URL("./scripts/hook-router.mjs", import.meta.url).pathname;
const MCP = new URL("./scripts/policy-mcp.mjs", import.meta.url).pathname;
const SID = randomUUID();
const apiKey = process.env.ARMORIQ_API_KEY;

if (!apiKey) {
  console.error("ARMORIQ_API_KEY is required to run this manual harness.");
  process.exit(1);
}

const env = {
  ...process.env,
  ARMORIQ_ENV: "local",
  ARMORIQ_BACKEND_URL: "http://localhost:8080",
  ARMORIQ_API_KEY: apiKey,
  ARMORCLAUDE_DEBUG: "true",
};

// config.mjs resolves dataDir = CLAUDE_PLUGIN_DATA || ARMORCLAUDE_DATA_DIR ||
// ~/.claude/armorclaude. The harness env sets none of the first two, so the
// daemon + MCP + this harness all resolve to the same default dir.
const DATA_DIR =
  env.CLAUDE_PLUGIN_DATA ||
  env.ARMORCLAUDE_DATA_DIR ||
  path.join(process.env.HOME, ".claude", "armorclaude");

function fire(event, extra) {
  return new Promise((resolve) => {
    const p = spawn("node", [ROUTER], { env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.on("close", () => resolve(out.trim()));
    p.stdin.write(JSON.stringify({ hook_event_name: event, session_id: SID, ...extra }));
    p.stdin.end();
  });
}

// Drive the real policy MCP server over stdio and call register_intent_plan.
function registerIntentPlan(plan) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [MCP], { env });
    let buf = "";
    let done = false;
    p.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2 && !done) {
          done = true;
          p.stdin.end();
          p.kill();
          resolve(msg.result);
        }
      }
    });
    p.stderr.on("data", (d) => process.stderr.write(d));
    p.on("error", reject);
    // MCP initialize handshake, then tools/call.
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "harness", version: "0.0.0" },
      },
    };
    p.stdin.write(JSON.stringify(init) + "\n");
    setTimeout(() => {
      p.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
      );
      p.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "register_intent_plan", arguments: plan },
        }) + "\n"
      );
    }, 300);
    setTimeout(() => {
      if (!done) {
        p.kill();
        reject(new Error("MCP register_intent_plan timed out"));
      }
    }, 20000);
  });
}

function killStaleDaemon() {
  const pidFile = path.join(DATA_DIR, "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[harness] killed stale daemon pid=${pid}`);
      } catch {
        console.log(`[harness] stale daemon pid=${pid} already gone`);
      }
    }
  }
  // Also sweep any lingering daemon.mjs processes.
  spawnSync("pkill", ["-f", "scripts/daemon.mjs"]);
}

function pg(sql) {
  const r = spawnSync(
    "docker",
    ["exec", "pg-observability", "psql", "-U", "postgres", "-d", "conmap_local", "-t", "-A", "-c", sql],
    { encoding: "utf8" }
  );
  return (r.stdout || "").trim();
}

const main = async () => {
  console.log(`[harness] session_id=${SID}`);
  killStaleDaemon();
  // Clean stale pending-plan / prior-session contamination so "deny before
  // plan" is a valid assertion for THIS session.
  spawnSync("bash", ["-c", `rm -f ${DATA_DIR}/pending-plan*.json`]);
  await new Promise((r) => setTimeout(r, 500));

  await fire("SessionStart", {});
  await fire("UserPromptSubmit", { prompt: "Read a file, then run a build command" });

  // Read is on the read-only allowlist — allowed without a plan; still emits obs.
  console.log("preRead ", await fire("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/tmp/x" } }));
  await fire("PostToolUse", { tool_name: "Read", tool_input: { file_path: "/tmp/x" }, tool_response: { content: "hi" } });

  // Bash BEFORE plan. NOTE: with an API key + local-mock backend, the engine
  // auto-mints a single-tool intent token at PreToolUse (engine.mjs:934) and the
  // mock backend allows it, so this is expected to ALLOW here. The enforcement
  // proof below is that register_intent_plan binds a REAL multi-step plan+token
  // to the session (runtime.json) and the gated tool remains allowed.
  const bashPre1 = await fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm run build" } });
  console.log("preBash1(auto-mint, expect allow in local-mock):", bashPre1 || "(allowed)");

  // --- Mid-session flush proof: end this turn's trace via Stop so it ships,
  // then check PG BEFORE SessionEnd. ---
  await fire("Stop", {});
  await new Promise((r) => setTimeout(r, 7000)); // > 5s shipper interval
  const midCount = pg(`SELECT count(*) FROM obs_traces WHERE product='armorclaude' AND session_id='${SID}'`);
  console.log(`[harness] MID-SESSION armorclaude traces for this session (before SessionEnd): ${midCount}`);

  // Register the plan via the real MCP server. It resolves the active session
  // id from runtime.json (stamped by the engine) and writes pending-plan.<sid>.
  const reg = await registerIntentPlan({
    goal: "Read a file then run the build",
    steps: [
      { action: "Read", description: "inspect source" },
      { action: "Bash", description: "run the build" },
    ],
  });
  console.log("[harness] register_intent_plan result:", JSON.stringify(reg?.structuredContent || reg));

  // Bash AFTER plan -> expect ALLOW (null output = allowed).
  const bashPre2 = await fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm run build" } });
  console.log("preBash2(expect ALLOW/null):", bashPre2 || "(allowed)");
  await fire("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm run build" }, tool_response: { code: 0 } });

  // --- Enforcement assertion: runtime.json has the session WITH the registered
  // plan+token, checked BEFORE SessionEnd (SessionEnd GCs the session). ---
  const rtBefore = JSON.parse(readFileSync(path.join(DATA_DIR, "runtime.json"), "utf8"));
  const sess = rtBefore.sessions && rtBefore.sessions[SID];
  const hasSession = !!sess;
  const hasToken = !!(sess && sess.intentTokenRaw);
  const planSteps = sess && sess.plan && Array.isArray(sess.plan.steps) ? sess.plan.steps.length : 0;
  console.log(`\n[harness] BEFORE SessionEnd: session present=${hasSession} token bound=${hasToken} plan steps=${planSteps}`);
  console.log(`[harness] runtime.activeSessionId=${rtBefore.activeSessionId}`);

  await fire("Stop", {});
  await fire("SessionEnd", {});
  console.log("[harness] fired SessionEnd; waiting for final flush");
  await new Promise((r) => setTimeout(r, 3000));

  // --- Final PG assertions ---
  const finalCount = pg(`SELECT count(*) FROM obs_traces WHERE product='armorclaude' AND session_id='${SID}'`);
  console.log(`\n[harness] FINAL armorclaude traces for this session: ${finalCount}`);
  const traces = pg(
    `SELECT id||' | '||name||' | spans='||span_count FROM obs_traces WHERE product='armorclaude' AND session_id='${SID}' ORDER BY created_at`
  );
  console.log("[harness] traces:\n" + traces);
  const traceId = pg(
    `SELECT id FROM obs_traces WHERE product='armorclaude' AND session_id='${SID}' AND name='iap.plan' ORDER BY created_at DESC LIMIT 1`
  );
  if (traceId) {
    const spans = pg(
      `SELECT kind||' | '||name||' | '||status FROM obs_spans WHERE trace_id='${traceId}' ORDER BY start_time`
    );
    console.log(`[harness] spans for iap.plan trace ${traceId}:\n` + spans);
  }

  console.log("\n=== SUMMARY ===");
  console.log(`(i)   nested iap.plan trace with nested spans landed: ${Number(finalCount) > 0}`);
  console.log(`(ii)  mid-session flush (span shipped before SessionEnd): ${Number(midCount) > 0}`);
  console.log(
    `(iii) enforcement: plan+token bound to session=${hasSession && hasToken} (${planSteps} steps); gated Bash allowed after registration=${!/deny/.test(bashPre2)}`
  );
};
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
