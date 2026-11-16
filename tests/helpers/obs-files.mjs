import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function deadPid() {
  return spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  }).stdout;
}

export function placeFile(dir, name, text = "{}") {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, name), text, { mode: 0o600 });
  return name;
}
