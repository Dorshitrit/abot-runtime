import { projectAvailableSkillsInstructions } from "../../knowledge-skills/available-skills-projection.js";
import {
  buildRuntimeFilesystemScopeMessage,
  canEstablishRuntimeWorkingDirectory,
} from "../../context/runtime-filesystem-scope.js";
import { canAuthorDirectResponseMemory, resolveDirectResponseOffer } from "./direct-response-policy.js";
import { buildDirectResponseInstructions } from "./direct-response-prompt.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { buildSparkConversationInstructions } from "../../context/spark-conversation-policy.js";
import type {
  ChatMessage,
  ModelGatewayJsonSchemaFormat,
} from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { projectRequestContext } from "../../context/request-context.js";
import { projectRootSessionMemory } from "../../context/session-memory/root-projection.js";
import { buildConversationMemoryAvailabilityInstructions } from "../../long-term-memory/conversation-authoring/prompt.js";
import { buildConversationMemoryAuthoringPlainTextMessage } from "../../long-term-memory/conversation-authoring/plain-text-context.js";
import type { ExecutionMemoryProjection } from "../../long-term-memory/initial-context.js";
import { canOfferMemoryRecall } from "../../long-term-memory/recall-policy.js";
import { projectMemoryRecallContinuations } from "../../long-term-memory/recall-continuation.js";
import { buildRequestTemporalContextMessage } from "../../context/request-temporal-context.js";
import { projectScheduledExecutionContext } from "../../context/scheduled-execution-context.js";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../../context/operation-supervision-evidence.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import type {
  CapabilityCatalogGroup,
  CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";
import {
  resolveRequestWorkerCapabilities,
  type RequestExecutionScope,
} from "../../request/execution-scope.js";
import { resolveRequestCapabilityBriefEntries } from "../../request/capability-brief.js";
import { appendRequestSteeringContext } from "../../request/request-steering-context.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import {
  EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID,
  projectAuditorInputState,
} from "../auditor-decision/index.js";
import {
  EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX,
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  type ExecutionAgentDecisionContractOptions,
} from "./contracts.js";
import {
  projectEligibleControlsEvidenceExecutionIds,
  requiresControlsEvidenceSelection,
} from "./controls-evidence-contract.js";
import {
  createExecutionAgentDecisionFormat,
  prepareExecutionAgentDecisionContract,
} from "./format.js";
import { projectExecutionWorkPlanOptions } from "./work-plan-sources.js";
import { buildExecutionAgentInstructions } from "./prompt.js";
import { appendExecutionEvidenceReuseInstructions } from "./evidence-reuse-instructions.js";
import {
  assertExecutionAgentCanonicalSource,
  resolveExecutionCapabilityScope,
  type ExecutionCapabilityScope,
} from "./capability-scope.js";
import {
  buildExecutionObservationGuidanceInstructions,
  type ExecutionObservationGuidance,
} from "./observation-guidance.js";
import {
  buildExecutionCapabilityCatalogMessage,
  buildExecutionCapabilityGroupCatalogMessage,
  buildExecutionContinuationMessages,
  buildExecutionDecisionStateMessage,
} from "./state-context.js";

export type ExecutionAgentInput = Readonly<{
  context: RequestContextProjection;
  messages: ReturnType<typeof appendRequestSteeringContext>;
  format: ModelGatewayJsonSchemaFormat;
  contract: ExecutionAgentDecisionContractOptions;
  modelStep: typeof EXECUTION_AGENT_DECISION_MODEL_STEP;
  capabilityCatalogGroups: readonly CapabilityCatalogGroup[];
  capabilities: readonly CapabilityDescriptor[];
  eligibleSessionArtifactPaths: readonly string[];
}>;

type BuildExecutionAgentInputOptions = Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  steeringSnapshot: RequestSteeringSnapshot;
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  allowPlanner: boolean;
  allowAuditor: boolean;
  memoryRecallMessage?: ChatMessage;
  memoryContext?: ExecutionMemoryProjection;
  capabilityScope?: ExecutionCapabilityScope;
  observationGuidance?: readonly ExecutionObservationGuidance[];
}>;

export function buildExecutionAgentInput(
  request: RequestExecutionScope,
  options: BuildExecutionAgentInputOptions,
): ExecutionAgentInput {
  assertExecutionAgentCanonicalSource(request, options.head, options.call);
  const directResponse = resolveDirectResponseOffer(request, options.head, options.call);
  const {
    capabilities,
    capabilityCatalogGroups,
    activeCapabilityCatalogGroupIds,
    knownGroupIds,
    remainingExecutions,
    capabilityScopeAction,
  } = options.capabilityScope ?? resolveExecutionCapabilityScope(request, options);
  const eligibleSessionArtifactPaths = projectEligibleSessionArtifactPaths(
    request.sessionArtifactPaths,
    options.head,
    options.call,
  );
  const auditInput = projectAuditorInputState(
    options.head,
    options.call.callId,
    options.steeringSnapshot.version,
  );
  const availableAuditCriterionIds =
    options.allowAuditor && auditInput.available
      ? Object.freeze([EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID])
      : Object.freeze([]);
  const memoryRecallMessage = request.longTermMemory?.enabled
    ? options.memoryRecallMessage
    : undefined;
  const memoryContext = request.longTermMemory?.enabled ? options.memoryContext : undefined;
  const automaticMemoryMessage = memoryRecallMessage ? undefined : memoryContext?.memoryMessage;
  const workPlan = projectExecutionWorkPlanOptions(options.head, options.call);
  const directMemoryAuthoring = canAuthorDirectResponseMemory(directResponse.maxLength, memoryContext)
    ? { ...(memoryContext.authoringContext ? { context: memoryContext.authoringContext } : {}) }
    : undefined;
  const contract = Object.freeze({
    ...(directResponse.maxLength !== undefined
      ? { directResponseMaxLength: directResponse.maxLength } : {}),
    ...(directMemoryAuthoring ? { directResponseMemoryAuthoring: directMemoryAuthoring } : {}),
    ...(workPlan ? { workPlan } : {}),
    allowMemoryRecall: canOfferMemoryRecall({
      enabled: request.longTermMemory?.enabled === true,
      recallCount: options.head.state.memoryRecalls.length,
      maxRecallCallsPerRequest: request.memoryRecallLimit,
    }),
    capabilities,
    eligibleControlsEvidenceExecutionIds:
      projectEligibleControlsEvidenceExecutionIds(options.head, options.call),
    capabilityCatalogGroupIds: knownGroupIds,
    activeCapabilityCatalogGroupIds,
    maxBatchCapabilityExecutions: Math.min(
      EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX,
      Math.max(0, remainingExecutions),
    ),
    includeAcknowledgement: options.includeAcknowledgement,
    includeTitle: options.includeTitle,
    allowRespond: true,
    allowPlanner: options.allowPlanner,
    allowAuditor: availableAuditCriterionIds.length > 0,
    availableAuditCriterionIds,
    includeWorkingDirectory: options.call.workingDirectory === undefined,
  } satisfies ExecutionAgentDecisionContractOptions);
  const preparedContract = prepareExecutionAgentDecisionContract(contract);
  const hasControlsEvidenceSelection = preparedContract.capabilities.some(
    ({ partition }) => requiresControlsEvidenceSelection(partition),
  );
  const format = createExecutionAgentDecisionFormat(contract);
  const filesystemMessage = buildRuntimeFilesystemScopeMessage({
    scope: request.workerCapabilities.filesystemScope,
    workingDirectory: options.call.workingDirectory,
    capabilities,
    canSelectWorkingDirectory: canEstablishRuntimeWorkingDirectory(
      options.call.workingDirectory,
      preparedContract.capabilities.length > 0,
    ),
  });
  const instructions = [
    buildExecutionAgentInstructions({
      allowDirectResponse: directResponse.maxLength !== undefined,
      allowWorkPlan: workPlan !== undefined,
      allowMemoryRecall: contract.allowMemoryRecall,
      hasMemoryRecallContext: memoryRecallMessage !== undefined,
      hasCapabilities: capabilities.length > 0,
      hasControlsEvidenceSelection,
      hasCapabilityCatalogGroups: capabilityCatalogGroups.length > 0,
      capabilityScopeAction,
      allowPlanner: options.allowPlanner,
      availableAuditCriterionCount: availableAuditCriterionIds.length,
      allowRespond: true,
      includeAcknowledgement: options.includeAcknowledgement,
      includeTitle: options.includeTitle,
      includeWorkingDirectory: options.call.workingDirectory === undefined,
    }),
    ...buildExecutionObservationGuidanceInstructions(
      capabilities, options.observationGuidance ?? [],
    ),
    ...buildDirectResponseInstructions(
      directResponse.maxLength, request.runnerConfig, directMemoryAuthoring !== undefined,
    ),
    ...buildConversationMemoryAvailabilityInstructions(
      request.longTermMemory?.enabled === true,
    ),
    ...buildSparkConversationInstructions(request.sessionKind),
  ].join("\n");
  const scheduledExecution = projectScheduledExecutionContext(
    request,
    instructions,
    "decision",
  );
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const operationSupervisionEvidenceMessage =
    buildImmediateOperationSupervisionEvidenceMessage(
      options.head,
      options.call,
    );
  const referenceMessages = [
    ...(filesystemMessage ? [filesystemMessage] : []),
    ...scheduledExecution.referenceMessages,
    ...(automaticMemoryMessage ? [automaticMemoryMessage] : []),
    ...(directMemoryAuthoring?.context
      ? [buildConversationMemoryAuthoringPlainTextMessage(directMemoryAuthoring.context)] : []),
    ...(request.temporalContext
      ? [buildRequestTemporalContextMessage(request.temporalContext)]
      : []),
    buildExecutionDecisionStateMessage(
      options.head,
      options.call,
      options.steeringSnapshot.version,
      hasControlsEvidenceSelection
        ? contract.eligibleControlsEvidenceExecutionIds
        : undefined,
    ),
    ...(operationSupervisionEvidenceMessage
      ? [operationSupervisionEvidenceMessage]
      : []),
    buildExecutionCapabilityGroupCatalogMessage(
      knownGroupIds,
      resolveRequestCapabilityBriefEntries(
        resolveRequestWorkerCapabilities(request), capabilityCatalogGroups,
      ),
    ),
    ...(capabilities.length > 0
      ? [buildExecutionCapabilityCatalogMessage(capabilities)]
      : []),
  ];
  const continuationMessages = buildExecutionContinuationMessages(
    options.head,
    options.call,
    projectMemoryRecallContinuations(memoryRecallMessage),
  );
  const sessionMemory = projectRootSessionMemory(request);
  traceDebug("runtime.execution-agent", "direct_response.offer", {
    requestId: request.requestId, reason: directResponse.reason,
    maxLength: directResponse.maxLength ?? null,
  });
  const contextInput: Parameters<typeof projectRequestContext>[0] = {
    instructions: appendExecutionEvidenceReuseInstructions({
      instructions: scheduledExecution.instructions,
      hasCapabilities: capabilities.length > 0,
    }),
    format,
    ...sessionMemory,
    prompt: request.prompt,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    referenceMessages,
    ...(continuationMessages.length > 0 ? { continuationMessages } : {}),
    deferCompactionFailure: true,
    budget,
    diagnostic: {
      requestId: request.requestId,
      modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
      callId: options.call.callId,
    },
    onEvent: request.onEvent,
  };
  const skills = remainingExecutions > 0
    ? resolveRequestWorkerCapabilities(request).provider.getAvailableSkills?.() ?? []
    : [];
  const context = projectRequestContext({
    ...contextInput,
    instructions: projectAvailableSkillsInstructions({
      skills, context: contextInput,
    }),
  });
  return Object.freeze({
    context,
    messages: appendRequestSteeringContext(
      context.messages,
      options.steeringSnapshot,
    ),
    format,
    contract,
    modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
    capabilityCatalogGroups,
    capabilities,
    eligibleSessionArtifactPaths,
  });
}

function projectEligibleSessionArtifactPaths(
  sessionArtifactPaths: readonly string[] | undefined,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): readonly string[] {
  if (!sessionArtifactPaths || sessionArtifactPaths.length === 0) {
    return Object.freeze([]);
  }
  const currentRequestTargets = new Set(
    head.state.capabilityExecutions
      .filter(
        (execution) =>
          execution.callId === call.callId && execution.status === "settled",
      )
      .flatMap((execution) =>
        (execution.references ?? [])
          .filter((reference) => reference.kind === "tool_target")
          .map((reference) => reference.target),
      ),
  );
  return Object.freeze(
    sessionArtifactPaths
      .slice(0, 8)
      .filter((target) => !currentRequestTargets.has(target)),
  );
}
