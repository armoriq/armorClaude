import { createRequire } from "node:module";

// The SDK root eagerly loads axios and OpenTelemetry (~150 ms), and every hook
// is a fresh Node process. Load only the SDK module a caller uses, on first use.
const require = createRequire(import.meta.url);
const loaded = new Map();

function load(name) {
  try {
    return require(`@armoriq/sdk-dev/dist/${name}`);
  } catch (err) {
    // An installed SDK laid out differently, or one that hides dist behind an
    // exports map, still serves its exports from the root.
    if (err?.code !== "MODULE_NOT_FOUND" && err?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED")
      throw err;
    process.stderr.write(
      `[armorclaude] SDK module ${name} not found by name, loading the SDK root: ${err.code}\n`
    );
    return require("@armoriq/sdk-dev");
  }
}

export function sdkModule(name) {
  if (!loaded.has(name)) loaded.set(name, load(name));
  return loaded.get(name);
}
