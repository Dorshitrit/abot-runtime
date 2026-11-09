import type { SupervisorToolEvidence } from "../../context/supervisor-tool-evidence.js";
import { buildSparkConversationInstructions } from "../../context/spark-conversation-policy.js";
import type { RequestContextPinnedPart, RequestContextProjection } from "../../context/request-context-contracts.js";
import type {
  ChatMessage,
  ModelGatewayJsonSchemaFormat,
} from "../../../model-gateway/types.js";
import { projectRequestContext } from "../../context/request-context.js";
import { projectScheduledExecutionContext } from "../../context/scheduled-execution-context.js";
import { projectRootSessionMemory } from "../../context/session-memory/root-projection.js";
import {
  buildRequestToolResultsMessage,
  type RequestToolResultsView,
} from "../../context/request-tool-results.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import { projectResponseMemoryRecall } from "../../long-term-memory/recall-continuation.js";
import { interleaveSupervisorMemoryRecalls } from "../supervisor-decision/memory-recall-continuation.js";
import {
  buildSupervisorChildContinuationParts, buildSupervisorContinuationPart, hasSupervisorWorkerSteeringHandoff,
} from "../supervisor-decision/resume.js";
import {
  SUPERVISOR_RESPONSE_MODEL_STEP,
  type SupervisorResponseCallIdentity,
  type SupervisorResponseDiagnosticContext,
  type SupervisorResponseResumeContext,
} from "./contracts.js";
import { traceSupervisorResponseContextProjected } from "./diagnostics.js";
import { createSupervisorMemoryCandidatesFormat } from "./memory-authoring.js";
import { buildSupervisorResponseRecommendationMessage } from "./response-recommendation.js";
import {
  buildSupervisorMemoryAuthoringInstructions,
  buildSupervisorResponseInstructions,
} from "./prompt.js";
import { automationResponseFormat } from "../../request/automation-output-contract.js";
import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";
import { buildCoreSkillReadContextMessages } from "../../context/core-skill-read-context.js";

export type SupervisorResponseInputRequest = Pick<
  RequestExecutionSeed,
  | "requestId"
  | "prompt"
  | "historyMessages"
  | "sessionKind"
  | "runnerConfig"
  | "attachments"
  | "agentMode"
  | "modelPreference"
  | "modelPolicy"
  | "scheduledExecution"
  | "automationOutputContract"
> &
  Partial<Pick<RequestExecutionSeed, "onEvent" | "sessionMemory">>;

export function buildSupervisorResponseInput(
  request: SupervisorResponseInputRequest,
  options: SupervisorResponseInputOptions,
): {
  context: RequestContextProjection;
  modelStep: typeof SUPERVISOR_RESPONSE_MODEL_STEP;
} {
  const responseRecommendationMessage =
    buildSupervisorResponseRecommendationMessage(options);
  const scheduledExecution = projectScheduledExecutionContext(
    request,
    [buildSupervisorResponseInstructions({
      hasResponseRecommendation: responseRecommendationMessage !== undefined,
      hasCompletedChildResult: options.resume !== undefined,
      hasWorkerSteeringHandoff: options.resume !== undefined &&
        hasSupervisorWorkerSteeringHandoff({
          resume: options.resume,
          currentCallId: options.call.callId,
          currentInvocationAttempt: options.call.invocationAttempt,
        }),
      hasRequestToolResults: options.toolResults.results.length > 0,
      ...(options.memoryCandidateCount !== undefined ? { memoryCandidateCount: options.memoryCandidateCount } : {}),
      ...(options.hasDirectMemorySaveRequest !== undefined ? { hasDirectMemorySaveRequest: options.hasDirectMemorySaveRequest } : {}),
    }), ...buildSparkConversationInstructions(request.sessionKind), ...(request.automationOutputContract
      ? ["Return one JSON object matching the automation result schema, with no surrounding text."]
      : [])].join("\n"),
    "response",
  );
  return buildSupervisorInput(request, options, {
    ...scheduledExecution,
    referenceMessages: [
      ...(scheduledExecution.referenceMessages ?? []),
      ...buildCoreSkillReadContextMessages(options.skillReadHead),
    ],
    ...(request.automationOutputContract
      ? { format: automationResponseFormat(request.automationOutputContract) }
      : {}),
    responseRecommendationMessage,
  });
}

export function buildSupervisorMemoryAuthoringInput(
  request: SupervisorResponseInputRequest,
  options: SupervisorResponseInputOptions,
): {
  context: RequestContextProjection;
  modelStep: typeof SUPERVISOR_RESPONSE_MODEL_STEP;
} {
  return buildSupervisorInput(request, options, {
    instructions: buildSupervisorMemoryAuthoringInstructions({
      hasCompletedChildResult: options.resume !== undefined,
      hasRequestToolResults: options.toolResults.results.length > 0,
    }),
    format: createSupervisorMemoryCandidatesFormat(),
    ...(options.memoryAuthoringMessage ? { referenceMessages: [options.memoryAuthoringMessage] } : {}),
  });
}

type SupervisorResponseInputOptions = Readonly<{
  responseRecommendation?: string;
  responseRecommendationOrigin?: "skill_authoring_no_save";
  call: SupervisorResponseCallIdentity;
  toolResults: RequestToolResultsView;
  supervisorToolEvidence?: SupervisorToolEvidence;
  skillReadHead?: RoleCallLedgerHead;
  resume?: SupervisorResponseResumeContext;
  initialMemoryMessage?: ChatMessage;
  memoryRecallMessage?: ChatMessage;
  memoryAuthoringMessage?: ChatMessage;
  memoryCandidateCount?: number;
  hasDirectMemorySaveRequest?: boolean;
}>;

function buildSupervisorInput(
  request: SupervisorResponseInputRequest,
  options: SupervisorResponseInputOptions,
  contract: Readonly<{
    instructions: string;
    referenceMessages?: readonly ChatMessage[];
    format?: ModelGatewayJsonSchemaFormat;
    responseRecommendationMessage?: ChatMessage;
  }>,
): {
  context: RequestContextProjection;
  modelStep: typeof SUPERVISOR_RESPONSE_MODEL_STEP;
} {
  const diagnostic: SupervisorResponseDiagnosticContext = {
    requestId: request.requestId,
    modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
    ...options.call,
  };
  const recall = options.memoryRecallMessage ? projectResponseMemoryRecall(options.memoryRecallMessage) : undefined;
  const continuationParts = buildResponseContinuationParts(options, recall);
  const referenceMessages = [
    ...(contract.referenceMessages ?? []),
    ...(contract.responseRecommendationMessage
      ? [contract.responseRecommendationMessage]
      : []),
    ...(options.supervisorToolEvidence?.buildMessages() ??
      (options.toolResults.results.length > 0
        ? [buildRequestToolResultsMessage(options.toolResults)]
        : [])),
    ...(!recall && options.initialMemoryMessage ? [options.initialMemoryMessage] : []),
  ];
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const sessionMemory = projectRootSessionMemory(request);
  const context = projectRequestContext({
    instructions: recall?.omissionNotice ? [contract.instructions, recall.omissionNotice].join("\n\n") : contract.instructions,
    ...sessionMemory,
    ...(contract.format ? { format: contract.format } : {}),
    prompt: request.prompt,
    currentMessagePlacement: "after_continuation",
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(referenceMessages.length > 0 ? { referenceMessages } : {}),
    ...(continuationParts.length > 0 ? { continuationParts } : {}),
    budget,
    diagnostic,
    ...(request.onEvent ? { onEvent: request.onEvent } : {}),
    deferCompactionFailure: true,
  });

  traceSupervisorResponseContextProjected({
    diagnostic,
    context,
    historyMessageCount: sessionMemory.historyMessages.length,
    attachmentCount: request.attachments?.length ?? 0,
    referenceMessageCount: referenceMessages.length,
    responseRecommendationLength: contract.responseRecommendationMessage
      ? (options.responseRecommendation?.length ?? 0)
      : 0,
    continuationMessageCount: continuationParts.reduce((count, part) => count + part.messages.length, 0),
    completedChildResultCount: options.resume?.completedChildren.length ?? 0,
    completedChildSummaryLength:
      options.resume?.completedChildren.reduce(
        (total, child) => total + child.summary.length,
        0,
      ) ?? 0,
  });

  return { context, modelStep: SUPERVISOR_RESPONSE_MODEL_STEP };
}

/** Terminal authors see one compact receipt per child, even when recalls are interleaved. */
function buildResponseContinuationParts(
  options: SupervisorResponseInputOptions,
  recall: ReturnType<typeof projectResponseMemoryRecall> | undefined,
): readonly RequestContextPinnedPart[] {
  const childContext = options.resume && {
    resume: options.resume,
    currentCallId: options.call.callId,
    currentInvocationAttempt: options.call.invocationAttempt,
  };
  if (recall) {
    const children = childContext && buildSupervisorChildContinuationParts(childContext).map(compactChildPart);
    return interleaveSupervisorMemoryRecalls(recall.continuations, options.call.callId, children);
  }
  return childContext ? [compactChildPart(buildSupervisorContinuationPart(childContext))] : [];
}

function compactChildPart(part: RequestContextPinnedPart): RequestContextPinnedPart {
  if (!part.compactMessages) throw new Error("supervisor_response_result_projection_unavailable");
  return Object.freeze({ ...part, messages: part.compactMessages });
}
