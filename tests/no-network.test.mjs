import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

// Every blocked attempt runs in a child process: the guard fails any process
// that tried to leave loopback, and this file must stay clean itself.
const HOST = "armorclaude-tests.example.invalid";

function runChild(body) {
  const script = `
    import http from "node:http";
    import net from "node:net";
    import tls from "node:tls";
    const report = (error) => console.log(JSON.stringify({ code: error.code, message: error.message }));
    ${body}
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
  });
  const lines = child.stdout.trim().split("\n").filter(Boolean);
  return { status: child.status, stderr: child.stderr, errors: lines.map((l) => JSON.parse(l)) };
}

function assertBlocked(result, ports) {
  assert.deepEqual(
    result.errors.map((e) => e.code),
    ports.map(() => "ERR_TEST_NETWORK_BLOCKED")
  );
  ports.forEach((port, i) => assert.ok(result.errors[i].message.includes(`${HOST}:${port}`)));
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`no-network: blocked .*${HOST.replaceAll(".", "\\.")}`));
}

test("the test command loads the no-network preload for child processes", () => {
  assert.match(process.env.NODE_OPTIONS ?? "", /tests\/setup\/no-network\.mjs/);
});

test("fetch to a non-loopback host rejects and names the host", () => {
  assertBlocked(runChild(`await fetch("https://${HOST}/v1/traces").catch(report);`), [443]);
});

test("http.get to a non-loopback host fails and names the host", () => {
  const result = runChild(`
    try {
      http.get("http://${HOST}:8080/health").on("error", report);
    } catch (error) {
      report(error);
    }
  `);
  assertBlocked(result, [8080]);
});

test("net.connect and tls.connect to a non-loopback host throw", () => {
  const result = runChild(`
    try { net.connect(443, "${HOST}"); } catch (error) { report(error); }
    try { tls.connect({ host: "${HOST}", port: 8443 }); } catch (error) { report(error); }
  `);
  assertBlocked(result, [443, 8443]);
});

test("an attempt the code swallows still fails the process", () => {
  const result = runChild(`await fetch("https://${HOST}/health").catch(() => {});`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${HOST.replaceAll(".", "\\.")}:443`));
});

test("loopback TCP and unix sockets still connect", async () => {
  const server = http.createServer((_req, res) => res.end("loopback"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await res.text(), "loopback");
  await new Promise((resolve) => server.close(resolve));

  const socketPath = path.join(mkdtempSync(path.join(tmpdir(), "ac-nonet-")), "s.sock");
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const body = await new Promise((resolve, reject) => {
    http
      .get({ socketPath, path: "/" }, (response) => {
        response.setEncoding("utf8");
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve(text));
      })
      .on("error", reject);
  });
  assert.equal(body, "loopback");
  await new Promise((resolve) => server.close(resolve));
});
