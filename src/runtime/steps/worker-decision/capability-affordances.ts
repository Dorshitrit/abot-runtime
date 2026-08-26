import type { WorkerCapabilityDescriptor } from "../../orchestration/worker-capabilities/index.js";

export type WorkerCapabilityAffordance = Readonly<{
  capabilityId: string;
  summary: string;
  effect: WorkerCapabilityDescriptor["effect"];
}>;

/**
 * Projects only semantic capability-selection facts into the Worker prompt.
 * Ordinary refinement controls remain deferred. A descriptor may separately
 * mark identity-bearing controls that the selection schema binds and freezes.
 */
export function projectWorkerCapabilityAffordances(
  capabilities: readonly WorkerCapabilityDescriptor[],
): readonly WorkerCapabilityAffordance[] {
  return Object.freeze(
    capabilities.map(({ capabilityId, summary, effect }) =>
      Object.freeze({ capabilityId, summary, effect }),
    ),
  );
}
