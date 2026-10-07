import net from "node:net";

const INSTALLED = Symbol.for("armorclaude.tests.no-network");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host).toLowerCase());
}

function connectTarget(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") {
    return { path: first.path, host: first.host ?? "localhost", port: first.port };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) {
    return { path: first };
  }
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

function fetchTarget(input) {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return { host: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80) };
  } catch {
    return null;
  }
}

if (!globalThis[INSTALLED]) {
  globalThis[INSTALLED] = true;
  const attempts = [];

  const blocked = (host, port) => {
    attempts.push(`${host}:${port}`);
    const error = new Error(
      `no-network: a test tried to connect to ${host}:${port}. Tests may only reach 127.0.0.1, ::1, localhost or a unix socket.`
    );
    error.code = "ERR_TEST_NETWORK_BLOCKED";
    return error;
  };

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = connectTarget(args);
    if (!target.path && !isLoopbackHost(target.host)) {
      throw blocked(target.host, target.port);
    }
    return connect.apply(this, args);
  };

  const fetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const target = fetchTarget(input);
    if (target && !isLoopbackHost(target.host)) {
      return Promise.reject(blocked(target.host, target.port));
    }
    return fetch.call(this, input, init);
  };

  process.on("exit", () => {
    if (attempts.length === 0) return;
    process.stderr.write(
      `no-network: blocked ${attempts.length} connection(s) to ${[...new Set(attempts)].join(", ")}\n`
    );
    process.exitCode = 1;
  });

  const options = process.env.NODE_OPTIONS ?? "";
  if (!options.includes(import.meta.url)) {
    const self = `--import=${JSON.stringify(import.meta.url)}`;
    process.env.NODE_OPTIONS = [options, self].filter(Boolean).join(" ");
  }
}
