import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeToolName } from "./common.mjs";
import { environmentFor, loginCommand } from "./login-command.mjs";
export { environmentFor } from "./login-command.mjs";

const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/;
const WORKER = fileURLToPath(new URL("../reach-ping.mjs", import.meta.url));
const COUNT_FILE = /^counts-(\d{4}-\d{2}-\d{2})\.ndjson(\.sending)?$/;
const COUNT_METRICS = { plan: "plans", blocked: "blocked", held: "held" };
const PLAN_TOOL =
  /^mcp__(?:armorclaude-policy|plugin_armorclaude_armorclaude-policy)__(?:register_intent_plan|trust_reanchor)$/;
const NOTICE =
  "ArmorIQ sends an anonymous daily usage ping (a random install id, plugin and version, OS, signed in or not, and daily counts of plans and blocks); turn it off with ARMORIQ_USAGE_PING_DISABLED=1 or DO_NOT_TRACK=1.";

function signedIn(config) {
  return !config.unconfigured && !config.signedOut && config.armoriqEnv !== "local";
}

function countsDir(home, environment) {
  return path.join(home, ".armoriq/reach/v1/armorclaude", environment);
}

export function applyReach(event, input, config, output, deps = {}) {
  noteReach(event, input, config, output, deps);
  if (event !== "SessionStart") return output;
  const messages = [];
  const home = deps.home ?? homedir();
  const environment = environmentFor(config.backendEndpoint);
  try {
    if (config.usagePingEnabled && config.armoriqEnv !== "local" && environment) {
      const dir = path.join(home, ".armoriq/reach/v1/armorclaude");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = openSync(path.join(dir, "notice-shown"), "wx", 0o600);
      closeSync(fd);
      messages.push(NOTICE);
    }
  } catch {
    // A failed notice claim cannot suppress the reminder.
  }
  try {
    if (
      config.signInReminderEnabled &&
      !signedIn(config) &&
      config.armoriqEnv !== "local" &&
      environment
    ) {
      const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
      const command = loginCommand(config.backendEndpoint);
      if (claimReminder(home, environment, day)) {
        messages.push(
          `ArmorClaude is not signed in to ArmorIQ. Sign in to see your plans and blocks on your dashboard: ${command} (hide this reminder: ARMORIQ_SIGNIN_REMINDER_DISABLED=1)`
        );
      }
    }
  } catch {
    // A failed reminder claim cannot suppress the notice.
  }
  if (!messages.length) return output;
  return {
    ...output,
    systemMessage: [output?.systemMessage, ...messages].filter(Boolean).join("\n\n"),
  };
}

function claimReminder(home, environment, day) {
  const dir = countsDir(home, environment);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  closeSync(openSync(path.join(dir, `reminder-${day}`), "wx", 0o600));
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("reminder-") || !(dayTime(day) - dayTime(name.slice(9)) > 30 * 86400000))
        continue;
      try {
        const file = path.join(dir, name);
        if (lstatSync(file).isFile()) unlinkSync(file);
      } catch {
        // Cleanup failures leave the daily claim intact.
      }
    }
  } catch {
    // Cleanup failures leave the daily claim intact.
  }
  return true;
}

export function noteReach(event, input, config, output, deps = {}) {
  let fd;
  try {
    if (!config.usagePingEnabled || signedIn(config)) return;
    const environment = environmentFor(config.backendEndpoint);
    if (!environment || config.armoriqEnv === "local") return;
    let metric;
    if (event === "PreToolUse") {
      const decision = output?.hookSpecificOutput?.permissionDecision;
      metric = decision === "deny" ? "blocked" : decision === "ask" ? "held" : null;
    } else if (event === "PostToolUse" && PLAN_TOOL.test(normalizeToolName(input?.tool_name))) {
      const success = normalizeToolName(input.tool_name).endsWith("__register_intent_plan")
        ? "Intent registered:"
        : "ReAnchor recorded.";
      if (!replyTexts(input.tool_response).some((text) => text.startsWith(success))) return;
      metric = "plan";
    }
    if (!metric) return;
    const dir = countsDir(deps.home ?? homedir(), environment);
    const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    fd = openSync(
      path.join(dir, `counts-${day}.ndjson`),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return;
    writeSync(fd, `${JSON.stringify({ t: metric })}\n`);
  } catch {
    // Counter failures cannot change the hook result.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A close failure cannot change the hook result.
      }
    }
  }
}

function replyTexts(response) {
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      return [response];
    }
  }
  if (!response || typeof response !== "object" || response.isError === true) return [];
  const blocks = Array.isArray(response) ? response : response.content;
  return [
    response.message,
    response.structuredContent?.message,
    ...(Array.isArray(blocks) ? blocks.map((part) => part?.text) : []),
  ].filter((text) => typeof text === "string");
}

export function settleCounts(files = [], acknowledged = false) {
  if (!Array.isArray(files)) return;
  for (const file of files) {
    let fd;
    try {
      if (typeof file !== "string" || !file.endsWith(".ndjson.sending")) continue;
      if (!acknowledged) {
        const target = file.slice(0, -8);
        try {
          // Replacing a late writer's file during rollback would lose its events.
          linkSync(file, target);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          const contents = readFileSync(file);
          fd = openSync(
            target,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_APPEND |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK,
            0o600
          );
          if (!fstatSync(fd).isFile() || writeSync(fd, contents) !== contents.length) continue;
        }
      }
      unlinkSync(file);
    } catch {
      // Unacknowledged files remain available to the next daily attempt.
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Cleanup failures cannot change the hook result.
        }
      }
    }
  }
}

export function collectCounts(home, environment, day) {
  const localCounts = [];
  const sendingFiles = [];
  const dir = countsDir(home, environment);
  const time = dayTime(day);
  if (!Number.isFinite(time)) return { localCounts, sendingFiles };
  try {
    lstatSync(dir);
  } catch (error) {
    if (error.code === "ENOENT") return { localCounts, sendingFiles };
    throw error;
  }
  for (const name of readdirSync(dir)) {
    const match = COUNT_FILE.exec(name);
    if (match?.[2] && Number.isFinite(dayTime(match[1]))) settleCounts([path.join(dir, name)]);
  }
  const days = [];
  for (const name of readdirSync(dir)) {
    const match = COUNT_FILE.exec(name);
    if (!match || match[2]) continue;
    const age = time - dayTime(match[1]);
    const file = path.join(dir, name);
    try {
      if (!lstatSync(file).isFile()) continue;
      if (age > 7 * 86400000) unlinkSync(file);
      else if (age > 0) days.push(match[1]);
    } catch {
      // An unreadable counter file can be retried on the next day.
    }
  }
  for (const countDay of days.sort().reverse().slice(0, 7)) {
    const file = path.join(dir, `counts-${countDay}.ndjson`);
    const sending = `${file}.sending`;
    try {
      try {
        lstatSync(sending);
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") continue;
      }
      renameSync(file, sending);
      const counts = { day: countDay, plans: 0, blocked: 0, held: 0 };
      for (const line of readFileSync(sending, "utf8").split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (
            !entry ||
            Object.keys(entry).length !== 1 ||
            typeof entry.t !== "string" ||
            !Object.hasOwn(COUNT_METRICS, entry.t)
          )
            continue;
          const metric = COUNT_METRICS[entry.t];
          counts[metric] = Math.min(100000, counts[metric] + 1);
        } catch {
          // Partial and unknown lines carry no metric.
        }
      }
      sendingFiles.push(sending);
      if (counts.plans || counts.blocked || counts.held) localCounts.push(counts);
    } catch {
      settleCounts([sending]);
    }
  }
  return { localCounts, sendingFiles };
}

export function pingEnabled({ env, home, pluginDisabled }) {
  try {
    if (pluginDisabled === true) return false;
    if (["1", "true"].includes(env.DO_NOT_TRACK?.trim().toLowerCase())) return false;
    if (["1", "true", "yes"].includes(env.ARMORIQ_USAGE_PING_DISABLED?.trim().toLowerCase()))
      return false;
    let settings;
    try {
      settings = JSON.parse(readFileSync(path.join(home, ".armoriq/settings.json"), "utf8"));
    } catch (error) {
      return error.code === "ENOENT";
    }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return false;
    return !Object.hasOwn(settings, "usagePing") || settings.usagePing === true;
  } catch {
    return false;
  }
}

export function reminderEnabled({ env, home, pluginDisabled }) {
  try {
    if (pluginDisabled === true) return false;
    if (["1", "true", "yes"].includes(env.ARMORIQ_SIGNIN_REMINDER_DISABLED?.trim().toLowerCase()))
      return false;
    let settings;
    try {
      settings = JSON.parse(readFileSync(path.join(home, ".armoriq/settings.json"), "utf8"));
    } catch (error) {
      return error.code === "ENOENT";
    }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return false;
    return !Object.hasOwn(settings, "signInReminder") || settings.signInReminder === true;
  } catch {
    return false;
  }
}

function readInstallId(file) {
  let fd;
  try {
    if (!lstatSync(file).isFile()) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 37) return null;
    const value = readFileSync(fd, "utf8");
    return value.length === 37 && INSTALL_ID.test(value) ? value.slice(0, -1) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A close failure cannot change the hook result.
      }
    }
  }
}

export function ensureInstallId(home) {
  let fd;
  let temp;
  try {
    const dir = path.join(home, ".armoriq");
    const file = path.join(dir, "install-id");
    try {
      lstatSync(file);
      return readInstallId(file);
    } catch (error) {
      if (error.code !== "ENOENT") return null;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    const tempFile = path.join(dir, `install-id.${process.pid}.${randomUUID()}.tmp`);
    fd = openSync(tempFile, "wx", 0o600);
    temp = tempFile;
    writeFileSync(fd, `${id}\n`);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(temp, file);
      return id;
    } catch (error) {
      if (error.code === "EEXIST") return readInstallId(file);
    }
    // Filesystems without hard links need exclusive creation; a single write narrows
    // the window in which a racing reader can see an empty file.
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      return error.code === "EEXIST" ? readInstallId(file) : null;
    }
    return writeSync(fd, `${id}\n`) === 37 ? id : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A close failure cannot change the hook result.
      }
    }
    if (temp !== undefined) {
      try {
        unlinkSync(temp);
      } catch {
        // Cleanup failures cannot change the hook result.
      }
    }
  }
}

function dayTime(day) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : NaN;
}

export function claimDay({ home, plugin, environment, day }) {
  try {
    if (!["armorclaude", "armorcodex", "armoropencode", "armorantigravity"].includes(plugin))
      return false;
    if (!["production", "staging"].includes(environment)) return false;
    const time = dayTime(day);
    if (!Number.isFinite(time)) return false;
    const dir = path.join(home, ".armoriq/reach/v1", plugin, environment);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(path.join(dir, `ping-${day}`), "wx", 0o600);
    closeSync(fd);
    try {
      for (const name of readdirSync(dir)) {
        if (!name.startsWith("ping-") || !(time - dayTime(name.slice(5)) > 30 * 86400000)) continue;
        try {
          const file = path.join(dir, name);
          if (lstatSync(file).isFile()) unlinkSync(file);
        } catch {
          // Cleanup failures leave the daily claim intact.
        }
      }
    } catch {
      // Cleanup failures leave the daily claim intact.
    }
    return true;
  } catch {
    return false;
  }
}

export function buildBody({ installId, config, signedIn, environment, platform }) {
  try {
    return {
      schemaVersion: 1,
      installId,
      plugin: "armorclaude",
      pluginVersion: config.clientVersion.split("/")[1],
      hostAgent: "claude-code",
      hostVersion: null,
      os: { darwin: "macos", linux: "linux", win32: "windows" }[platform] ?? "other",
      signedIn,
      environment,
      localCounts: [],
    };
  } catch {
    return null;
  }
}

function spawnWorker(input) {
  const child = spawn(process.execPath, [WORKER], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.on("error", () => undefined);
  child.stdin.on("error", () => undefined);
  child.stdin.end(JSON.stringify(input));
  child.unref();
}

export function launchReach(event, input, config, deps = {}) {
  try {
    if (event !== "SessionStart" && event !== "UserPromptSubmit") return;
    const env = deps.env ?? process.env;
    const home = deps.home ?? homedir();
    if (!pingEnabled({ env, home, pluginDisabled: config.usagePingDisabled })) return;
    const environment = environmentFor(config.backendEndpoint);
    if (!environment || config.armoriqEnv === "local") return;
    const installId = ensureInstallId(home);
    if (!installId) return;
    const day = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
    if (!claimDay({ home, plugin: "armorclaude", environment, day })) return;
    const body = buildBody({
      installId,
      config,
      signedIn: signedIn(config),
      environment,
      platform: deps.platform ?? process.platform,
    });
    if (!body) return;
    (deps.spawnWorker ?? spawnWorker)({
      origin: config.backendEndpoint,
      day,
      body,
      transcriptPath: typeof input.transcript_path === "string" ? input.transcript_path : null,
    });
  } catch {
    // A failed spawn cannot change the hook result.
  }
}
