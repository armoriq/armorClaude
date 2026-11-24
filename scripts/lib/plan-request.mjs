import { sha256Hex } from "./common.mjs";

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === "string") {
    if (/\p{Surrogate}/u.test(value)) throw new TypeError("Canonical JSON requires valid Unicode");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON requires a JSON value");
}

export function planHash(plan) {
  return sha256Hex(canonicalJson(plan));
}

export function idempotencyKey(input) {
  const fields =
    input.kind === "refresh"
      ? ["refresh", input.countedPlanId, input.tokenExpiresAt]
      : [input.kind, input.promptId, input.parentPlanId || "", input.planHash];
  if (input.kind !== "refresh" && input.epoch >= 1) fields.push(`epoch:${input.epoch}`);
  return `pcc1:${sha256Hex(fields.join("\n"))}`;
}
