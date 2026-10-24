import type { ChatMessage } from "../../../model-gateway/types.js";
import { resolveMemoryRecallSteeringVersion } from "../../long-term-memory/recall-binding.js";
import { buildSupervisorMemoryRecallContinuationParts } from "./memory-recall-continuation.js";
import { buildSparkConversationInstructions } from "../../context/spark-conversation-policy.js";
import { projectLatestSettledConversationTurn, projectRequestContext } from "../../context/request-context.js";
import { buildRequestTemporalContextMessage } from "../../context/request-temporal-context.js";
import { projectScheduledExecutionContext } from "../../context/scheduled-execution-context.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { SUPERVISOR_DECISION_MODEL_STEP, SUPERVISOR_DELEGATE_ROLE_IDS } from "./contracts.js";
import { createSupervisorDelegationFormat } from "./delegation-contract.js";
import { buildSupervisorDelegationInstructions } from "./delegation-prompt.js";
import { projectSupervisorArtifactPaths } from "./artifact-paths.js";
import type { buildSupervisorDecisionInput, SupervisorDecisionInputRequest } from "./input.js";

/**
 * Initial delegation uses one exact settled conversation turn, not the full routing
 * history or captured Skill bodies. Those remain available to their execution
 * owners. This projection is phase-local and never changes session checkpoints.
 */
export function buildSupervisorDelegationInput(
  request: SupervisorDecisionInputRequest,
  options: Parameters<typeof buildSupervisorDecisionInput>[1],
): ReturnType<typeof buildSupervisorDecisionInput> {
  const allowedRoleIds = [...new Set(options.allowedRoleIds ?? SUPERVISOR_DELEGATE_ROLE_IDS)]
    .filter((role) => role === "worker" || role === "planner");
  const allowMemoryRecall = options.allowMemoryRecall === true && options.memoryRecallMessage === undefined;
  const continuationParts = [];
  if (options.memoryRecallMessage) {
    const diagnostic = options.diagnostic;
    if (!diagnostic?.callId || !diagnostic.invocationAttempt)
      throw new Error("supervisor_recall_call_identity_required");
    resolveMemoryRecallSteeringVersion(options.memoryRecallMessage, request.requestId, diagnostic.callId);
    continuationParts.push(...buildSupervisorMemoryRecallContinuationParts({
      memoryRecallMessage: options.memoryRecallMessage,
      currentCallId: diagnostic.callId,
      currentInvocationAttempt: diagnostic.invocationAttempt,
    }));
  }
  const format = createSupervisorDelegationFormat({ allowedRoleIds, allowMemoryRecall });
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    modelPreference: request.modelPreference,
    modelPolicy: request.modelPolicy,
  });
  const instructions = [
    buildSupervisorDelegationInstructions({
      allowedRoleIds, allowMemoryRecall, hasMemoryRecallContext: options.memoryRecallMessage !== undefined,
    }),
    ...buildSparkConversationInstructions(request.sessionKind),
  ].join("\n");
  const scheduledExecution = projectScheduledExecutionContext(request, instructions, "decision");
  const referenceMessages: ChatMessage[] = [
    ...scheduledExecution.referenceMessages,
    ...(!options.memoryRecallMessage && options.initialMemoryMessage ? [options.initialMemoryMessage] : []),
    ...(request.temporalContext ? [buildRequestTemporalContextMessage(request.temporalContext)] : []),
  ];
  const historyMessages = projectLatestSettledConversationTurn(request.historyMessages) ?? [];
  const contextInput: Parameters<typeof projectRequestContext>[0] = {
    instructions: scheduledExecution.instructions,
    format,
    prompt: request.prompt,
    historyMessages,
    // Keep this single source turn whole. The exact model-step admission still
    // accounts for it and rejects oversize input before any child is dispatched.
    historyRetention: "compaction_managed",
    referenceMessages,
    continuationParts,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    budget,
    diagnostic: options.diagnostic,
    onEvent: request.onEvent,
    deferCompactionFailure: true,
  };
  const artifactPathsProjection = projectSupervisorArtifactPaths({
    targets: request.sessionArtifactPaths,
    context: contextInput,
    additionalBudgetMessages: options.capabilityBriefBudgetMessages,
  });
  if (artifactPathsProjection) referenceMessages.push(artifactPathsProjection.message);
  const projected = projectRequestContext({
    ...contextInput,
    instructions: artifactPathsProjection?.instructions ?? contextInput.instructions,
  });
  const selectedIds = new Set(projected.selectedHistoryMessageIds);
  const context = {
    ...projected,
    omittedHistoryMessageIds: request.historyMessages
      .filter((message) => !selectedIds.has(message.id)).map((message) => message.id),
  };
  traceDebug("runtime.supervisor", "delegation.context.projected", {
    ...options.diagnostic,
    messageCount: context.messages.length,
    messageCharacterCount: context.messages.reduce((sum, message) => sum + message.content.length, 0),
    selectedHistoryMessageCount: context.selectedHistoryMessageIds.length,
    omittedHistoryMessageCount: context.omittedHistoryMessageIds.length,
    referenceMessageCount: referenceMessages.length,
    allowedRoleIds,
  });
  return {
    context, format, modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    delegationOnly: true,
    includeAcknowledgement: false, includeTitle: false, includeResponseRecommendation: false,
    allowMemoryRecall, allowSkillAuthoring: false, allowedRoleIds,
    workerCapabilityAffordances: [], availableWorkerCapabilityCatalog: [],
    ...(artifactPathsProjection ? { artifactPathsProjection } : {}),
  };
}
