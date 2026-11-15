import { createRequire } from "node:module";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

const PRODUCT = "armorclaude";
const ORIGINS = new Map([
  ["https://api.armoriq.ai", "production"],
  ["https://staging-api.armoriq.ai", "staging"],
  ["https://staging-api.armoriq.io", "staging"],
]);

export function environmentFor(origin) {
  return ORIGINS.get(origin) ?? null;
}

export function declaredCli({ name, bin }) {
  const clis = bin !== null && typeof bin === "object" ? Object.keys(bin) : [];
  if (clis.length !== 1)
    throw new Error(`${name} must declare exactly one CLI in its package.json bin`);
  return clis[0];
}

function commandPrefix() {
  const sdkPackage = createRequire(import.meta.url)("@armoriq/sdk/package.json");
  const cli = declaredCli(sdkPackage);
  const onPath = (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      const file = path.join(dir || ".", cli);
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
  return onPath ? cli : `npx -y ${sdkPackage.name}`;
}

export function loginCommand(backend) {
  const command = `${commandPrefix()} login --product ${PRODUCT}`;
  if (!backend) return command;
  try {
    const origin = new URL(backend).origin;
    const argument = environmentFor(origin) ? origin : `'${origin.replaceAll("'", "'\\''")}'`;
    return `${command} --backend ${argument}`;
  } catch {
    return command;
  }
}

export function statusCommand() {
  return `${commandPrefix()} status`;
}

export const notSignedIn = (backend) =>
  `No ArmorClaude login for ${backend}. Run: ${loginCommand(backend)}`;
