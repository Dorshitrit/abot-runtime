import type {
  ChatMessage,
  ModelGatewayJsonSchemaFormat,
} from "../../../model-gateway/types.js";
import type { MemoryCandidate } from "../../long-term-memory/contracts.js";
import {
  invokeStructuredModelStep,
  type StructuredModelParseResult,
} from "../../model/invoke-structured-step.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import { isModelStepSteeringSuperseded } from "../../model/model-step-steering.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { BoundRequestModelInvocationContext } from "../../request/contracts.js";
import { conversationMemoryCandidatesSchema, conversationMemoryPostValidatedSchemaConstraints, parseConversationMemoryCandidates } from "../../long-term-memory/conversation-authoring/contract.js";
import type { ConversationMemoryAuthoringContext } from "../../long-term-memory/conversation-authoring/context.js";
import { SUPERVISOR_RESPONSE_MODEL_STEP } from "./contracts.js";

const EMPTY_MEMORY_CANDIDATES: readonly MemoryCandidate[] = Object.freeze([]);

export function createSupervisorMemoryCandidatesFormat(): ModelGatewayJsonSchemaFormat {
  return Object.freeze({
    type: "json_schema" as const,
    name: "supervisor_memory_candidates",
    strict: true,
    postValidatedSchemaConstraints: conversationMemoryPostValidatedSchemaConstraints,
    schema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        memoryCandidates: conversationMemoryCandidatesSchema,
      }),
      required: Object.freeze(["memoryCandidates"]),
      additionalProperties: false,
    }),
  });
}

export async function authorSupervisorMemoryCandidates(params: {
  request: BoundRequestModelInvocationContext;
  messages: ChatMessage[];
  boundSteeringVersion?: number;
  contextCompaction?: ModelStepContextCompactionController;
  memoryAuthoringContext?: ConversationMemoryAuthoringContext;
}): Promise<readonly MemoryCandidate[]> {
  try {
    return await invokeStructuredModelStep({
      request: params.request,
      modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
      format: createSupervisorMemoryCandidatesFormat(),
      messages: params.messages,
      timeoutReason: "supervisor_memory_authoring_timeout",
      boundSteeringVersion: params.boundSteeringVersion,
      invalidOutputReason: "invalid_supervisor_memory_candidates",
      ...(params.contextCompaction
        ? { contextCompaction: params.contextCompaction }
        : {}),
      parse: (text) => parseSupervisorMemoryCandidates(text, params.memoryAuthoringContext),
    });
  } catch (error: unknown) {
    if (isModelStepSteeringSuperseded(error)) throw error;
    if (isPrimaryRequestAborted(params.request)) {
      throw error;
    }
    traceDebug("runtime.supervisor", "response.memory_authoring_isolated", {
      requestId: params.request.requestId,
      modelStep: SUPERVISOR_RESPONSE_MODEL_STEP,
      errorType:
        error instanceof Error && error.name ? error.name : typeof error,
    });
    return EMPTY_MEMORY_CANDIDATES;
  }
}

function parseSupervisorMemoryCandidates(
  text: string,
  context?: ConversationMemoryAuthoringContext,
): StructuredModelParseResult<readonly MemoryCandidate[]> {
  const envelope = decodeMemoryEnvelope(text);
  if (!envelope) {
    return invalidMemoryCandidates("supervisor_memory_candidates_json_invalid");
  }
  if (!Array.isArray(envelope.memoryCandidates)) {
    return invalidMemoryCandidates("supervisor_memory_candidates_missing");
  }
  return Object.freeze({
    ok: true as const,
    decision: parseConversationMemoryCandidates(envelope.memoryCandidates, context),
  });
}

function decodeMemoryEnvelope(
  text: string,
): Record<string, unknown> | undefined {
  try {
    return readObject(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function invalidMemoryCandidates(
  code: string,
): StructuredModelParseResult<readonly MemoryCandidate[]> {
  return Object.freeze({
    ok: false as const,
    stage: "supervisor_memory_candidates",
    issues: Object.freeze([
      Object.freeze({
        code,
        path: "memoryCandidates",
        message:
          "Return one structured response containing a memoryCandidates array.",
      }),
    ]),
  });
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isPrimaryRequestAborted(
  request: Pick<BoundRequestModelInvocationContext, "abortSignal">,
): boolean {
  return request.abortSignal.aborted;
}
