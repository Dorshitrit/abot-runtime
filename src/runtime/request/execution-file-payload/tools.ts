import { projectCapabilityScope, type CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import { createExecutionAgentDecisionFormat } from "../../steps/execution-agent/format.js";
import { parseExecutionAgentDecisionOutput } from "../../steps/execution-agent/parser.js";
import { EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX, type ExecutionAgentDecisionContractOptions } from "../../steps/execution-agent/contracts.js";
import { ownsExecutionDecisionControls } from "../../steps/execution-agent/capability-controls-partition.js";
import { buildExecutionObservationGuidanceInstructions } from "../../steps/execution-agent/observation-guidance.js";
import type { FilePayloadInput } from "./binding.js";
import { projectFilePayloadObservationCapabilities } from "./tool-scope.js";

export type FilePayloadToolCatalog = Readonly<{
  getDescriptors(): readonly CapabilityDescriptor[];
  getExecutionGuidance?(capabilityId: string): Promise<string> | string;
}>;

/** Reuse EA's contracts within the file author's observation-only tool scope. */
export async function buildFilePayloadTools(provider: FilePayloadToolCatalog, input: FilePayloadInput) {
  const scoped = projectCapabilityScope({
    entries: provider.getDescriptors(), scope: input.call.workerCapabilityScope,
    descriptorOf: (entry) => entry,
  }).entries;
  const capabilities = projectFilePayloadObservationCapabilities(scoped);
  if (capabilities.length === 0) return undefined;
  const contract: ExecutionAgentDecisionContractOptions = {
    capabilities, activeCapabilityCatalogGroupIds: input.call.workerCapabilityScope?.catalogGroupIds,
    eligibleControlsEvidenceExecutionIds: input.settledCapabilityResults
      .filter((result) => result.callId === input.call.callId).map((result) => result.executionId),
    maxBatchCapabilityExecutions: EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX,
    allowRespond: false,
  };
  const guidance = await Promise.all(capabilities.filter(ownsExecutionDecisionControls).map(async ({ capabilityId }) => ({
    capabilityId, guidance: ((await provider.getExecutionGuidance?.(capabilityId)) ?? "").trim(),
  })));
  return {
    contract,
    instructions: [
      "You may instead return toolPrefix + a JSON decision envelope conforming to execution_file_tools_v1 + suffix. Only invoke_capability or invoke_capabilities is allowed in this frame. Choose only an offered observation capability to obtain information needed for the accepted assignment; its normal permissions and limits still apply.",
      "Mutating and mixed-effect capabilities are unavailable here. Return the accepted write body directly; if another change is required first, decline with the reason so the Execution Agent can decide it.",
      "A tool frame suspends this write without applying it. After the capability settles, this same assignment resumes with its canonical result, including failures. Do not include file content in a tool frame or expand the accepted assignment.",
      ...buildExecutionObservationGuidanceInstructions(capabilities, guidance),
    ].join("\n"),
    message: { role: "user" as const, content: JSON.stringify({
      kind: "execution_file_tools_v1", authority: "runtime_contract",
      purpose: "optional_capability_selection_for_the_accepted_file_assignment",
      presenceEffect: "no_new_user_intent_permissions_or_completion_evidence",
      applicability: "tool_frame_only", omissionMeaning: "unoffered_capabilities_are_unavailable",
      capabilities: capabilities.map(({ capabilityId, summary, effect }) => ({ capabilityId, summary, effect })),
      decisionFormat: createExecutionAgentDecisionFormat(contract).schema,
    }) },
  };
}

export function parseFilePayloadToolSelection(text: string, contract: ExecutionAgentDecisionContractOptions) {
  const parsed = parseExecutionAgentDecisionOutput(text, {
    ...contract,
    capabilities: projectFilePayloadObservationCapabilities(contract.capabilities ?? []),
  });
  if (!parsed.ok) throw new Error("payload_model_output_invalid");
  if (parsed.decision.action !== "invoke_capability" && parsed.decision.action !== "invoke_capabilities") {
    throw new Error("payload_model_output_invalid");
  }
  return parsed.decision;
}
