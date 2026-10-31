import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import { isExecutionSessionMemoryScope } from "../../../sessions/memory/checkpoint-scope.js";
import { readExecutionToolObservation } from "../../../sessions/memory/execution-observation.js";
import type { SessionMemoryCheckpoint } from "../../../sessions/memory/contracts.js";
import type { SessionMemorySourceSnapshot } from "../../../sessions/memory/source.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import { buildRequestSourceMessage, projectRequestSource } from "../request-source.js";
import type { RequestSessionMemory, SessionMemoryRequestProjection } from "./contracts.js";
import { createSessionMemoryAwareCompactionController } from "./model-step-controller.js";

type ReferenceRequest = Readonly<{ requestId: string; prompt: string; sessionMemory?: RequestSessionMemory }>;
type ReferenceConsumer = Readonly<{ modelStep: ModelStep; callId: string }>;
type HistoricalObservation = Readonly<{
  messageId: string;
  requestId: string;
  results: readonly unknown[];
}>;

/** Ordinary conversation and legacy snapshots keep their existing consumer inputs. */
export function hasExecutionHistoryReference(memory?: RequestSessionMemory): boolean {
  return readReferenceSource(memory) !== undefined;
}

/** A consumer-local view; the original memory remains the source and checkpoint owner. */
export function createExecutionHistoryReferenceMemory(
  request: ReferenceRequest,
  consumer: ReferenceConsumer,
): RequestSessionMemory | undefined {
  const reference = readReferenceSource(request.sessionMemory);
  if (!reference || !request.sessionMemory) return undefined;
  const memory = request.sessionMemory;
  const project = (projection: SessionMemoryRequestProjection, checkpoint?: SessionMemoryCheckpoint) =>
    projectReferenceMemory(request, consumer, reference.source, reference.observations, projection, checkpoint);
  return Object.freeze({
    snapshot: () => memory.snapshot!(),
    project: () => project(memory.project(), memory.snapshot!().checkpoint),
    async prepare(...args: Parameters<RequestSessionMemory["prepare"]>) {
      const prepared = await memory.prepare(...args);
      return Object.freeze({
        ...prepared,
        projection: project(prepared.projection, prepared.checkpoint),
      });
    },
  });
}

export function createExecutionHistoryReferenceCompactionController(
  request: Parameters<typeof createSessionMemoryAwareCompactionController>[0],
  memory: RequestSessionMemory | undefined,
  active: ModelStepContextCompactionController,
): ModelStepContextCompactionController {
  if (!memory) return active;
  return createSessionMemoryAwareCompactionController({ ...request, sessionMemory: memory }, active);
}

function readReferenceSource(memory?: RequestSessionMemory) {
  const snapshot = memory?.snapshot?.();
  if (!isExecutionSessionMemoryScope(snapshot?.scope)) return undefined;
  if (!isExecutionSessionMemoryScope(snapshot?.source.scope)) return undefined;
  const source = snapshot!.source;
  const observations = source.historyMessages.flatMap((message): HistoricalObservation[] => {
    if (message.role !== "assistant") return [];
    const observation = readExecutionToolObservation(message);
    if (!observation) return [];
    return [{ messageId: message.id, requestId: observation.requestId, results: observation.results }];
  });
  if (observations.length === 0) return undefined;
  return { source, observations };
}

function projectReferenceMemory(
  request: ReferenceRequest,
  consumer: ReferenceConsumer,
  source: SessionMemorySourceSnapshot,
  observations: readonly HistoricalObservation[],
  projection: SessionMemoryRequestProjection,
  checkpoint?: SessionMemoryCheckpoint,
): SessionMemoryRequestProjection {
  const uncoveredIds = new Set(projection.historyMessages.map(({ id }) => id));
  const rawMessages = new Map(source.historyMessages.map((message) => [message.id, message]));
  const plainHistory = projection.historyMessages.map((message) => ({
    ...message,
    content: rawMessages.get(message.id)!.content,
  }));
  const requestSource = buildRequestSourceMessage(projectRequestSource({
    requestId: request.requestId,
    prompt: request.prompt,
    ...consumer,
    historyMessages: plainHistory,
  }));
  const uncovered = observations.filter(({ messageId }) => uncoveredIds.has(messageId));
  const coveredIds = new Set(checkpoint?.coveredMessages.map(({ messageId }) => messageId));
  const hasCoveredObservations = observations.some(({ messageId }) => coveredIds.has(messageId));
  const priorConversationMessages: ChatMessage[] = [
    requestSource,
    ...(hasCoveredObservations ? projection.priorConversationMessages : []),
    ...(uncovered.length > 0 ? [buildHistoricalToolReference(request.requestId, consumer, uncovered)] : []),
  ];
  return Object.freeze({
    ...projection,
    historyMessages: Object.freeze([]),
    priorConversationMessages: Object.freeze(priorConversationMessages),
    compactableTurnCount: uncovered.length > 0 ? projection.compactableTurnCount : 0,
  });
}

function buildHistoricalToolReference(
  requestId: string,
  consumer: ReferenceConsumer,
  observations: readonly HistoricalObservation[],
): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: "runtime_execution_history_reference_v1",
      authority: "prior_conversation",
      purpose: "reuse_retained_tool_observations_for_the_current_accepted_assignment",
      currentRequestId: requestId,
      consumer,
      observations,
      coverage: "all_uncompacted_tool_observations",
      presenceEffect: "passive_reference_data_not_new_user_intent_work_authority_or_current_completion_evidence",
    }),
  });
}
