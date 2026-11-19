import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = process.argv[2] || fileURLToPath(new URL("../../", import.meta.url));
const hooks = new Set();
let transport;

function hook(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, "scripts/bootstrap.mjs"), "router"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    hooks.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      hooks.delete(child);
      if (code !== 0) reject(new Error(`${payload.hook_event_name} exited ${code}: ${stderr}`));
      else {
        try {
          resolve(stdout.trim() ? JSON.parse(stdout) : null);
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

process.on("message", async ({ id, type, payload, message }) => {
  try {
    let result;
    switch (type) {
      case "hook":
        result = await hook(payload);
        break;
      case "mcp-start":
        transport = new StdioClientTransport({
          command: process.execPath,
          args: [path.join(repoRoot, "scripts/bootstrap.mjs"), "mcp"],
          env: process.env,
          stderr: "pipe",
        });
        transport.onmessage = (message) => process.send({ type: "mcp-message", message });
        transport.onerror = (error) => process.send({ type: "mcp-error", error: error.message });
        transport.onclose = () => process.send({ type: "mcp-close" });
        await transport.start();
        break;
      case "mcp-send":
        await transport.send(message);
        break;
      case "mcp-close":
        await transport.close();
        break;
      default:
        throw new Error(`Unknown Claude test parent request: ${type}`);
    }
    process.send({ id, result });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});

process.on("disconnect", async () => {
  for (const child of hooks) child.kill("SIGKILL");
  if (transport) {
    transport.onclose = undefined;
    transport.onerror = undefined;
    transport.onmessage = undefined;
    await transport.close();
  }
});
