import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ExecutionAgentDecisionContractOptions } from "./contracts.js";
import type { ExecutionAgentInstructionOptions } from "./prompt.js";

export const EXECUTION_DECISION_CONTRACT_KIND = "runtime_execution_decision_contract_v1";

/** Live eligibility remains request/call-local; the provider schema grants no authority. */
export function buildExecutionDecisionContractMessage(params: Readonly<{
  requestId: string;
  callId: string;
  activationCount: number;
  instructions: ExecutionAgentInstructionOptions;
  contract: ExecutionAgentDecisionContractOptions;
  remainingExecutions: number;
}>): ChatMessage {
  const { stableContract: _stable, ...instructions } = params.instructions;
  const contract = params.contract;
  return {
    role: "user",
    content: JSON.stringify({
      kind: EXECUTION_DECISION_CONTRACT_KIND,
      authority: "runtime_state",
      purpose: "current_decision_eligibility_and_limits",
      binding: {
        requestId: params.requestId,
        callId: params.callId,
        activationCount: params.activationCount,
      },
      presenceEffect: "no_new_user_intent_permission_work_or_completion_evidence",
      ...instructions,
      limits: {
        remainingCapabilityExecutions: Math.max(0, params.remainingExecutions),
        maxBatchCapabilityExecutions: contract.maxBatchCapabilityExecutions ?? 0,
        directResponseMaxLength: contract.directResponseMaxLength ?? null,
      },
      offered: {
        capabilityIds: (contract.capabilities ?? []).map(({ capabilityId }) => capabilityId),
        catalogGroupIds: selectableCatalogGroupIds(contract, instructions.capabilityScopeAction),
        activeCatalogGroupIds: contract.activeCapabilityCatalogGroupIds ?? null,
        auditCriterionIds: contract.availableAuditCriterionIds ?? [],
        eligibleControlsEvidenceExecutionIds: contract.eligibleControlsEvidenceExecutionIds ?? [],
        workPlan: contract.workPlan ?? null,
        directResponseMemoryAuthoring: contract.directResponseMemoryAuthoring !== undefined,
      },
      omissionSemantics: "Only explicitly offered actions, IDs and fields are eligible. Omission grants no availability; the runtime validates this exact decision before execution.",
    }),
  };
}

function selectableCatalogGroupIds(
  contract: ExecutionAgentDecisionContractOptions,
  scopeAction: ExecutionAgentInstructionOptions["capabilityScopeAction"],
): readonly string[] {
  if (scopeAction === "open") return contract.capabilityCatalogGroupIds ?? [];
  if (scopeAction !== "extend") return [];
  const active = new Set(contract.activeCapabilityCatalogGroupIds ?? []);
  return (contract.capabilityCatalogGroupIds ?? []).filter((groupId) => !active.has(groupId));
}
