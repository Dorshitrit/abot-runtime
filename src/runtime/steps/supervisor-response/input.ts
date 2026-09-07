import type { RequestContextProjection } from "../../context/request-context-contracts.js";
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
import { buildSupervisorContinuationPart } from "../supervisor-decision/index.js";
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

export type SupervisorResponseInputRequest = Pick<
  RequestExecutionSeed,
  | "requestId"
  | "prompt"
  | "historyMessages"
  | "runnerConfig"
  | "attachments"
  | "agentMode"
  | "modelPreference"
  | "modelPolicy"
  | "scheduledExecution"
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
    buildSupervisorResponseInstructions({
      hasResponseRecommendation: responseRecommendationMessage !== undefined,
      hasCompletedChildResult: options.resume !== undefined,
      hasRequestToolResults: options.toolResults.results.length > 0,
    }),
    "response",
  );
  return buildSupervisorInput(request, options, {
    ...scheduledExecution,
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
  });
}

type SupervisorResponseInputOptions = Readonly<{
  responseRecommendation?: string;
  call: SupervisorResponseCallIdentity;
  toolResults: RequestToolResultsView;
  resume?: SupervisorResponseResumeContext;
  longTermMemoryMessage?: ChatMessage;
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
  const decisionContinuationPart = options.resume
    ? buildSupervisorContinuationPart({
        resume: options.resume,
        currentCallId: options.call.callId,
        currentInvocationAttempt: options.call.invocationAttempt,
      })
    : undefined;
  if (decisionContinuationPart && !decisionContinuationPart.compactMessages) {
    throw new Error("supervisor_response_result_projection_unavailable");
  }
  const roleContinuationPart =
    decisionContinuationPart?.compactMessages !== undefined
      ? Object.freeze({
          ...decisionContinuationPart,
          messages: decisionContinuationPart.compactMessages,
        })
      : undefined;
  const referenceMessages = [
    ...(contract.referenceMessages ?? []),
    ...(contract.responseRecommendationMessage
      ? [contract.responseRecommendationMessage]
      : []),
    ...(options.toolResults.results.length > 0
      ? [buildRequestToolResultsMessage(options.toolResults)]
      : []),
    ...(options.longTermMemoryMessage ? [options.longTermMemoryMessage] : []),
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
    instructions: contract.instructions,
    ...sessionMemory,
    ...(contract.format ? { format: contract.format } : {}),
    prompt: request.prompt,
    currentMessagePlacement: "after_continuation",
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(referenceMessages.length > 0 ? { referenceMessages } : {}),
    ...(roleContinuationPart
      ? { continuationParts: [roleContinuationPart] }
      : {}),
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
    continuationMessageCount: roleContinuationPart?.messages.length ?? 0,
    completedChildResultCount: options.resume?.completedChildren.length ?? 0,
    completedChildSummaryLength:
      options.resume?.completedChildren.reduce(
        (total, child) => total + child.summary.length,
        0,
      ) ?? 0,
  });

  return { context, modelStep: SUPERVISOR_RESPONSE_MODEL_STEP };
}
