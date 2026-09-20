import type { SystemProcessRunner, SystemTarget, SystemTargetId } from "./contracts.js";
import { observeSystemHost } from "./host-observation.js";
import { runSystemProcess } from "./process-runner.js";
import { resolveSystemTarget } from "./targets.js";

type TargetObservation = Readonly<
  | (SystemTarget & { available: true; commandExecutionAvailable: true; guiSessionStatus: "not_checked" })
  | { id: SystemTargetId; available: false; reason: string }
>;

export type SystemTargetObservation = Readonly<{
  host: ReturnType<typeof observeSystemHost>;
  availabilityScope: "command_execution_only";
  targets: readonly TargetObservation[];
}>;

export async function observeSystemTargets(
  run: SystemProcessRunner = runSystemProcess,
): Promise<SystemTargetObservation> {
  const observations: TargetObservation[] = [];
  for (const id of ["linux", "macos", "windows"] as const) {
    try {
      const target = await resolveSystemTarget(id, run);
      observations.push({
        ...target,
        available: true,
        commandExecutionAvailable: true,
        guiSessionStatus: "not_checked",
      });
    } catch (error) {
      observations.push({
        id,
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    host: observeSystemHost(),
    availabilityScope: "command_execution_only",
    targets: observations,
  };
}
