import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every level, so two configs that differ only
 * in key order produce the same text (and the same hash). Array order is kept:
 * it is meaningful (e.g. tool order).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** SHA-256 (hex) of the canonical JSON of an agent version config. */
export function hashConfig(config: unknown): string {
  return createHash("sha256").update(canonicalJson(config), "utf8").digest("hex");
}
