import type { WorkerCapabilityDescriptor } from "../../orchestration/worker-capabilities/index.js";
import type { SupervisorWorkerCapabilityAffordance } from "./contracts.js";

/**
 * Projects only the facts the Supervisor needs to decide whether Worker can
 * own the next outcome. Execution identity and controls remain Worker-private.
 */
export function projectSupervisorWorkerCapabilityAffordances(
  descriptors: readonly WorkerCapabilityDescriptor[],
): readonly SupervisorWorkerCapabilityAffordance[] {
  return Object.freeze(
    descriptors.map((descriptor) =>
      Object.freeze({
        purpose: descriptor.summary,
        effect: descriptor.effect,
      }),
    ),
  );
}
