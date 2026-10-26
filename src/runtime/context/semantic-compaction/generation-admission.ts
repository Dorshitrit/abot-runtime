import type { ChatMessage } from "../../../model-gateway/types.js";
import { projectConfiguredStepMessages, type ConfiguredStepInstructionPolicy } from "../../config/runner/step-instructions.js";
import { assessRequestMessagesBudget } from "../request-context-budget.js";
import { countModelInputTokens } from "../../model/input-token-count.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import { resolveModelContextAdmission } from "../../model/model-context-budget.js";
import { CONTEXT_COMPACTION_MODEL_STEP } from "./contracts.js";
import type { SemanticCompactionRequest } from "./generation-contracts.js";
import type { createSemanticCompactionFormat } from "./format.js";

export function assessSemanticCompactionMessages(
  request: SemanticCompactionRequest,
  messages: readonly ChatMessage[],
  format: ReturnType<typeof createSemanticCompactionFormat>,
  configuredInstructionPolicy?: ConfiguredStepInstructionPolicy,
) {
  const projectedMessages = projectSemanticCompactionMessages(
    request,
    messages,
    configuredInstructionPolicy,
  );
  return assessSemanticCompactionMessagesWithAdmission({
    admission: resolveSemanticCompactionAdmission(request, format),
    messages: projectedMessages,
  });
}

export async function assessSemanticCompactionMessagesForAdmission(
  request: SemanticCompactionRequest,
  messages: readonly ChatMessage[],
  format: ReturnType<typeof createSemanticCompactionFormat>,
  boundSteeringVersion: number | undefined,
  configuredInstructionPolicy?: ConfiguredStepInstructionPolicy,
) {
  const requestSteering = resolveRequestSteeringInbox(request.requestSteering);
  assertBoundModelStepSteeringCurrent(requestSteering, boundSteeringVersion);
  const admission = resolveSemanticCompactionAdmission(request, format);
  const projectedMessages = projectSemanticCompactionMessages(
    request,
    messages,
    configuredInstructionPolicy,
  );
  const measuredInputTokens = await countModelInputTokens({
    request,
    invocation: admission.invocation,
    modelStep: CONTEXT_COMPACTION_MODEL_STEP,
    messages: projectedMessages,
    format,
  });
  assertBoundModelStepSteeringCurrent(requestSteering, boundSteeringVersion);
  const assessment = assessSemanticCompactionMessagesWithAdmission({
    admission,
    messages: projectedMessages,
    ...(measuredInputTokens !== undefined ? { measuredInputTokens } : {}),
  });
  return Object.freeze({
    assessment,
    ...(admission.budget.tokenEstimation !== undefined
      ? { tokenEstimation: admission.budget.tokenEstimation }
      : {}),
  });
}

function projectSemanticCompactionMessages(
  request: SemanticCompactionRequest,
  messages: readonly ChatMessage[],
  configuredInstructionPolicy?: ConfiguredStepInstructionPolicy,
): ChatMessage[] {
  return projectConfiguredStepMessages({
    runnerConfig: request.runnerConfig,
    modelStep: CONTEXT_COMPACTION_MODEL_STEP,
    configuredInstructionPolicy,
    messages,
  }).messages;
}

function resolveSemanticCompactionAdmission(
  request: SemanticCompactionRequest,
  format: ReturnType<typeof createSemanticCompactionFormat>,
) {
  return resolveModelContextAdmission({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: CONTEXT_COMPACTION_MODEL_STEP,
    requestFormat: format,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
}

function assessSemanticCompactionMessagesWithAdmission(params: {
  admission: ReturnType<typeof resolveModelContextAdmission>;
  messages: readonly ChatMessage[];
  measuredInputTokens?: number;
}) {
  const calibrationInstructions = (
    params.admission.invocation.instructions ?? []
  )
    .map((instruction) => instruction.trim())
    .filter((instruction) => instruction.length > 0);
  const effectiveFormat = params.admission.effectiveFormat;
  return assessRequestMessagesBudget({
    messages:
      calibrationInstructions.length > 0
        ? [
            Object.freeze({
              role: "system" as const,
              content: calibrationInstructions.join("\n"),
            }),
            ...params.messages,
          ]
        : params.messages,
    ...(isSchemaFormat(effectiveFormat)
      ? { format: { schema: effectiveFormat.schema } }
      : {}),
    budget: params.admission.budget,
    ...(params.measuredInputTokens !== undefined
      ? { measuredInputTokens: params.measuredInputTokens }
      : {}),
  });
}

function isSchemaFormat(
  format: "json" | Record<string, unknown> | undefined,
): format is Record<string, unknown> & { schema: unknown } {
  return (
    format !== null &&
    typeof format === "object" &&
    Object.hasOwn(format, "schema")
  );
}
