import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../ports.js";

/** Rejects attaching a caller whose resolved execution configuration differs. */
export function resolveLocalRuntimeIdentity(config: RuntimeConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalConfigValue(config)))
    .digest("hex");
}

function canonicalConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalConfigValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalConfigValue(entry)]),
  );
}
