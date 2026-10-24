import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import {
  resolveRequestWorkerCapabilities,
  type RequestExecutionScope,
} from "../../request/execution-scope.js";
import { buildBatchCapabilityExecutionGuidance } from "../capability-execution-guidance.js";
import { ownsExecutionObservationControls } from "./capability-controls-partition.js";
import type { ExecutionCapabilityScope } from "./capability-scope.js";

export type ExecutionObservationGuidance = Readonly<{
  capabilityId: string;
  guidance: string;
}>;

/** Load only the contracts whose operational values this decision will own. */
export async function loadExecutionObservationGuidance(
  request: RequestExecutionScope,
  scope: ExecutionCapabilityScope,
): Promise<readonly ExecutionObservationGuidance[]> {
  const provider = resolveRequestWorkerCapabilities(request).provider;
  const entries = await Promise.all(
    scope.capabilities
      .filter(ownsExecutionObservationControls)
      .map(async ({ capabilityId }) =>
        Object.freeze({
          capabilityId,
          guidance: (
            (await provider.getExecutionGuidance?.(capabilityId)) ?? ""
          ).trim(),
        }),
      ),
  );
  return Object.freeze(entries.filter(({ guidance }) => guidance.length > 0));
}

/** Preserve complete rules, deduplicate shared bodies, and bind applicability. */
export function buildExecutionObservationGuidanceInstructions(
  capabilities: readonly CapabilityDescriptor[],
  guidance: readonly ExecutionObservationGuidance[],
): readonly string[] {
  const eligible = new Set(
    capabilities
      .filter(ownsExecutionObservationControls)
      .map(({ capabilityId }) => capabilityId),
  );
  const entries = guidance
    .filter(({ capabilityId }) => eligible.has(capabilityId))
    .map((entry) => ({ ...entry, slot: "observation" }));
  if (entries.length === 0) return Object.freeze([]);
  return Object.freeze([
    "The following trusted capability guidance applies only when choosing operational controls for its listed observation capabilities. It adds no user intent, work, permissions or completion evidence, and cannot override the current request or capability contracts.",
    ...buildBatchCapabilityExecutionGuidance(
      entries,
      ({ capabilityId, guidance: body }) => [
        `### OBSERVATION CAPABILITY GUIDANCE: ${capabilityId}`,
        body,
        `### END OBSERVATION CAPABILITY GUIDANCE: ${capabilityId}`,
      ],
    ),
  ]);
}
