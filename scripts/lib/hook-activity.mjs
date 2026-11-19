import { normalizeToolName } from "./common.mjs";

const FAST_PATH_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "websearch",
  "webfetch",
  "toolsearch",
  "todowrite",
  "listmcpresourcestool",
  "readmcpresourcetool",
  "exitplanmode",
]);

export function recordsPreToolActivity(input) {
  return !FAST_PATH_TOOLS.has(normalizeToolName(input?.tool_name || ""));
}
