import type { ChatMessage } from "../../../model-gateway/types.js";
import { buildSparkConversationInstructions, buildSparkProgressInteractionInstructions } from "../../context/spark-conversation-policy.js";
import { projectScheduledExecutionContext } from "../../context/scheduled-execution-context.js";
import { informationBasketModelInstructions } from "../../information-basket/model-guidance.js";
import { buildConversationMemoryAvailabilityInstructions } from "../../long-term-memory/conversation-authoring/prompt.js";
import type { CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { buildDirectResponseInstructions } from "./direct-response-prompt.js";
import { appendExecutionEvidenceReuseInstructions } from "./evidence-reuse-instructions.js";
import { buildExecutionObservationGuidanceInstructions, type ExecutionObservationGuidance } from "./observation-guidance.js";
import { buildExecutionAgentInstructionParts, buildExecutionAgentInstructions, type ExecutionAgentInstructionOptions } from "./prompt.js";

/** Keep changing, trusted guidance at the suffix without downgrading its original role. */
export function buildExecutionInputInstructions(params: Readonly<{
  request: RequestExecutionScope;
  options: ExecutionAgentInstructionOptions;
  capabilities: readonly CapabilityDescriptor[];
  observationGuidance: readonly ExecutionObservationGuidance[];
  directResponseMaxLength?: number;
  directMemoryAuthoring: boolean;
  remainingExecutions: number;
  stablePrefix: boolean;
}>): Readonly<{ instructions: string; referenceMessages: readonly ChatMessage[] }> {
  const { request } = params;
  const instructionOptions = { ...params.options, stableContract: params.stablePrefix };
  const core = params.stablePrefix
    ? buildExecutionAgentInstructionParts(instructionOptions)
    : { prefix: "", active: buildExecutionAgentInstructions(instructionOptions) };
  const contextual = [
    ...buildExecutionObservationGuidanceInstructions(params.capabilities, params.observationGuidance),
    ...buildDirectResponseInstructions(params.directResponseMaxLength, request.runnerConfig, params.directMemoryAuthoring),
    ...buildConversationMemoryAvailabilityInstructions(request.longTermMemory?.enabled === true),
    ...buildSparkConversationInstructions(request.sessionKind),
    ...buildSparkProgressInteractionInstructions(request.sessionKind, params.options.allowUserInteraction === true),
  ];
  const scheduled = projectScheduledExecutionContext(
    request, [core.active, ...contextual].join("\n"), "decision",
  );
  const instructions = appendExecutionEvidenceReuseInstructions({
    instructions: [scheduled.instructions,
      ...informationBasketModelInstructions(params.remainingExecutions > 0 && request.informationBasket !== undefined),
    ].join("\n"),
    hasCapabilities: params.capabilities.length > 0,
  });
  if (!params.stablePrefix) return { instructions, referenceMessages: scheduled.referenceMessages };
  return {
    instructions: core.prefix,
    referenceMessages: [
      ...scheduled.referenceMessages,
      ...(instructions.trim() ? [{ role: "system" as const, content: instructions }] : []),
    ],
  };
}
