import { readBoundedInteger } from "../../../src/plugin-sdk/index.js";
import { DEFAULT_EXEC_OUTPUT_RETENTION_MS } from "./output-contracts.js";

export type ExecSettings = Readonly<{
  hardTimeoutMs: number;
  yieldAfterMs: number;
  idleTimeoutMs: number;
  outputRetentionMs?: number;
}>;

export const DEFAULT_EXEC_HARD_TIMEOUT_MS = 600_000;
export const DEFAULT_EXEC_YIELD_AFTER_MS = 15_000;
export const DEFAULT_EXEC_IDLE_TIMEOUT_MS = 120_000;
export const EXEC_COMMAND_MAX_CHARS = 8_192;

export function readExecSettings(
  config: Readonly<Record<string, unknown>> | undefined,
): ExecSettings {
  return Object.freeze({
    outputRetentionMs: readBoundedInteger(config?.outputRetentionMs, {
      defaultValue: DEFAULT_EXEC_OUTPUT_RETENTION_MS,
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
      name: "outputRetentionMs",
    }),
    hardTimeoutMs: readBoundedInteger(config?.timeoutMs, {
      defaultValue: DEFAULT_EXEC_HARD_TIMEOUT_MS,
      minimum: 1,
      maximum: 3_600_000,
      name: "timeoutMs",
    }),
    yieldAfterMs: readBoundedInteger(config?.yieldAfterMs, {
      defaultValue: DEFAULT_EXEC_YIELD_AFTER_MS,
      minimum: 1,
      maximum: 600_000,
      name: "yieldAfterMs",
    }),
    idleTimeoutMs: readBoundedInteger(config?.idleTimeoutMs, {
      defaultValue: DEFAULT_EXEC_IDLE_TIMEOUT_MS,
      minimum: 1,
      maximum: 3_600_000,
      name: "idleTimeoutMs",
    }),
  });
}
