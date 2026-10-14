import type { RequestExecutionScope } from "../request/execution-scope.js";
import type { ChatMessage, ModelGatewayAttachment } from "../../model-gateway/types.js";
import { resolveRequestSteeringInbox, type RequestSteeringSnapshot } from "../request/request-steering.js";
import type { RoleInitialMemory } from "../orchestration/role-calls/memory-recall-contract.js";
import { retrieveResponseLongTermMemory } from "./response-context.js";
import {
  prepareConversationMemoryKnowledge,
  buildConversationMemoryAuthoringContext,
  canAuthorConversationMemory,
  projectConversationMemoryKnowledge,
} from "./conversation-authoring/context.js";

/** Prepared once as part of the existing request ledger initialization. */
export async function prepareInitialMemory(
  request: RequestExecutionScope,
  restored?: RoleInitialMemory,
): Promise<RoleInitialMemory | undefined> {
  if (!usesInitialMemory(request)) return undefined;
  if (restored !== undefined) return restored;
  request.abortSignal.throwIfAborted();
  const steering = resolveRequestSteeringInbox(request.requestSteering).snapshot();
  const message = await retrieveResponseLongTermMemory(request, steering);
  request.abortSignal.throwIfAborted();
  // EA prepares authoring targets at startup; Supervisor keeps its terminal step.
  const knowledge = usesInitialExecutionMemory(request)
    ? await prepareConversationMemoryKnowledge(request, steering)
    : undefined;
  request.abortSignal.throwIfAborted();
  return Object.freeze({
    ...(message ? { message: projectPersistentMemoryMessage(message) } : {}),
    ...(knowledge ? { knowledge: projectConversationMemoryKnowledge(knowledge) } : {}),
  });
}

function projectPersistentMemoryMessage(message: ChatMessage): ChatMessage {
  if (!message.attachments) return message;
  return { ...message, attachments: message.attachments.filter(isPersistentMemoryAttachment) };
}

function isPersistentMemoryAttachment(attachment: ModelGatewayAttachment): boolean {
  return attachment.toolEvidence === undefined;
}

function usesInitialMemory(request: RequestExecutionScope): boolean {
  if (!request.longTermMemory?.enabled) return false;
  if (request.executionPolicy.authority.id === "execution-agent-v1") return true;
  return request.executionPolicy.authority.id === "supervisor-worker-v1";
}

export function projectExecutionAgentMemory(
  request: RequestExecutionScope,
  initial: RoleInitialMemory | undefined,
  steering: RequestSteeringSnapshot,
) {
  if (!usesInitialExecutionMemory(request)) return { memoryMessage: undefined, authoringContext: undefined, authoringEnabled: false } as const;
  const authoringContext = initial?.knowledge
    ? buildConversationMemoryAuthoringContext(request, steering, {
        ...initial.knowledge, referenceTime: new Date().toISOString(),
      })
    : undefined;
  return Object.freeze({
    memoryMessage: initial?.message,
    authoringContext,
    authoringEnabled: canAuthorConversationMemory(request, authoringContext),
  });
}

function usesInitialExecutionMemory(request: RequestExecutionScope): boolean {
  if (!request.longTermMemory?.enabled) return false;
  return request.executionPolicy.authority.id === "execution-agent-v1";
}

export type ExecutionMemoryProjection = ReturnType<typeof projectExecutionAgentMemory>;
