import type { ModelStep } from "../../../shared/model-steps.js";
import { invalidRuntimeConfig, requireConfigRecord } from "./validation.js";

export const REQUEST_RUNNER_CONFIG_SCHEMA_VERSION = 2 as const;
export const LEGACY_REQUEST_STEP_TIMEOUT_MS = 90_000;

/**
 * Exact Model Step baseline shipped in @abot-ai/runtime 1.0.0.
 * Later steps may be absent from a legacy file and are filled by normalization.
 */
export const LEGACY_REQUEST_INVOKED_STEP_IDS = Object.freeze([
  "supervisor.decision",
  "supervisor.response",
  "worker.decision",
  "worker.result",
  "planner.decision",
  "planner.graph",
  "reviewer.decision",
  "degraded.finalization",
  "execution.decision",
  "execution.response",
  "auditor.decision",
  "context.compact",
  "tool_payload.raw",
] satisfies readonly ModelStep[]);

export type RequestRunnerConfigFileVersion = "legacy-v1" | 2;

export type VersionedRequestRunnerConfigRoot = Readonly<{
  root: Record<string, unknown>;
  version: RequestRunnerConfigFileVersion;
}>;

export function resolveRequestRunnerConfigFileVersion(
  value: unknown,
  configPath: string,
): VersionedRequestRunnerConfigRoot {
  const root = requireConfigRecord(value, configPath, "root");
  if (!Object.hasOwn(root, "schemaVersion")) {
    return { root, version: "legacy-v1" };
  }
  if (root.schemaVersion === REQUEST_RUNNER_CONFIG_SCHEMA_VERSION) {
    return { root, version: REQUEST_RUNNER_CONFIG_SCHEMA_VERSION };
  }
  throw invalidRuntimeConfig(
    configPath,
    "schemaVersion must be 2 or omitted for the legacy v1 format",
  );
}

export function assertSupportedRequestRunnerConfigVersion(
  value: unknown,
  configPath: string,
): void {
  resolveRequestRunnerConfigFileVersion(value, configPath);
}
