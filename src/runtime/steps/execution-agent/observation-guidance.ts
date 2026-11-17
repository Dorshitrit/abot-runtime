import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import {
  resolveRequestWorkerCapabilities,
  type RequestExecutionScope,
} from "../../request/execution-scope.js";
import { buildBatchCapabilityExecutionGuidance } from "../capability-execution-guidance.js";
import { ownsExecutionDecisionControls } from "./capability-controls-partition.js";
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
      .filter(ownsExecutionDecisionControls)
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
      .filter(ownsExecutionDecisionControls)
      .map(({ capabilityId }) => capabilityId),
  );
  const entries = guidance
    .filter(({ capabilityId }) => eligible.has(capabilityId))
    .map((entry) => ({ ...entry, slot: "observation" }));
  if (entries.length === 0) return Object.freeze([]);
  const preparedSource = capabilities.some((capability) => capability.preparedPayloadSource &&
    entries.some((entry) => entry.capabilityId === capability.capabilityId));
  const label = preparedSource ? "DECISION" : "OBSERVATION";
  return Object.freeze([
    `The following trusted capability guidance applies only when choosing operational controls for its listed ${preparedSource ? "capabilities" : "observation capabilities"}. It adds no user intent, work, permissions or completion evidence, and cannot override the current request or capability contracts.`,
    ...buildBatchCapabilityExecutionGuidance(
      preparedSource ? entries.map((entry) => ({ ...entry, slot: "decision" })) : entries,
      ({ capabilityId, guidance: body }) => [
        `### ${label} CAPABILITY GUIDANCE: ${capabilityId}`,
        body,
        `### END ${label} CAPABILITY GUIDANCE: ${capabilityId}`,
      ],
    ),
  ]);
}
