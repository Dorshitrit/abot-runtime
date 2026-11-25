import type { RoleCallFrame, RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import type { RequestExecutionScope } from "../execution-scope.js";
import type { RequestSteeringSnapshot } from "../request-steering.js";
import { resolveExecutionCapabilityScope } from "../../steps/execution-agent/capability-scope.js";
import { projectEligibleControlsEvidenceExecutionIds } from "../../steps/execution-agent/controls-evidence-contract.js";
import { projectEligibleSessionArtifactPaths } from "../../steps/execution-agent/input.js";
import { refineExecutionAgentDecision } from "../../steps/execution-agent/run.js";
import { EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX, type ExecutionAgentDecisionOutcome } from "../../steps/execution-agent/contracts.js";
import { projectFilePayloadContinuation } from "./continuation.js";
import { parseFilePayloadToolSelection } from "./tools.js";

/** Return accepted author choices to the ordinary root dispatcher, never execute here. */
export async function resumeFilePayloadAuthoring(request: RequestExecutionScope, options: Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  steeringSnapshot: RequestSteeringSnapshot;
}>): Promise<ExecutionAgentDecisionOutcome | undefined> {
  const pending = projectFilePayloadContinuation({
    executions: options.head.state.capabilityExecutions, call: options.call,
    steeringVersion: options.steeringSnapshot.version,
    capabilities: request.workerCapabilities.provider.getDescriptors(),
  });
  if (!pending) return undefined;
  if (!pending.observationToolsOnly) throw new Error("execution_file_handoff_incompatible");
  const scope = resolveExecutionCapabilityScope(request, options);
  if (!canResumeFilePayloadWriter(scope.capabilities, pending.pending.capabilityId)) return undefined;
  if (pending.phase === "write") return {
    decision: { action: "invoke_capability", ...pending.pending },
    steeringVersion: options.steeringSnapshot.version,
  };
  let selected;
  try {
    selected = parseFilePayloadToolSelection(pending.toolDecision, {
      capabilities: scope.capabilities, activeCapabilityCatalogGroupIds: scope.activeCapabilityCatalogGroupIds,
      eligibleControlsEvidenceExecutionIds: projectEligibleControlsEvidenceExecutionIds(options.head, options.call),
      maxBatchCapabilityExecutions: Math.min(EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX, Math.max(0, scope.remainingExecutions)),
      allowRespond: false,
    });
  } catch { return undefined; }
  const decision = await refineExecutionAgentDecision(request, options, scope.capabilities,
    projectEligibleSessionArtifactPaths(request.sessionArtifactPaths, options.head, options.call), selected);
  return { decision, steeringVersion: options.steeringSnapshot.version };
}

function canResumeFilePayloadWriter(capabilities: readonly CapabilityDescriptor[], capabilityId: string): boolean {
  return capabilities.some((capability) =>
    capability.capabilityId === capabilityId && capability.preparedPayloadSource === true);
}
