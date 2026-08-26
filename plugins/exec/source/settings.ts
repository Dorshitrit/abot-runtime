import { readBoundedInteger } from "../../../src/plugin-sdk/index.js";

export type ExecSettings = Readonly<{
  hardTimeoutMs: number;
  yieldAfterMs: number;
  idleTimeoutMs: number;
  outputMaxChars: number;
}>;

export const DEFAULT_EXEC_HARD_TIMEOUT_MS = 600_000;
export const DEFAULT_EXEC_YIELD_AFTER_MS = 15_000;
export const DEFAULT_EXEC_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_EXEC_OUTPUT_MAX_CHARS = 8_000;
export const EXEC_OUTPUT_MAX_CHARS = 8_000;
export const EXEC_COMMAND_MAX_CHARS = 4_096;

export function readExecSettings(
  config: Readonly<Record<string, unknown>> | undefined,
): ExecSettings {
  return Object.freeze({
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
    outputMaxChars: readBoundedInteger(config?.outputMaxChars, {
      defaultValue: DEFAULT_EXEC_OUTPUT_MAX_CHARS,
      minimum: 64,
      maximum: EXEC_OUTPUT_MAX_CHARS,
      name: "outputMaxChars",
    }),
  });
}
