import { createHash } from "node:crypto";

import { DEFAULT_RUNTIME_ID } from "./constants.js";
import type { AgentMode } from "./types.js";

export function normalizeRuntimeId(value: string): string {
  return value.trim().toLowerCase() || DEFAULT_RUNTIME_ID;
}

export function resolveAgentMode(value: unknown): AgentMode {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  if (mode === "fast") return "fast";
  if (mode === "deep") return "deep";
  return "reasoning";
}

export function stableBridgeToken(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}
