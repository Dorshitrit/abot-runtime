import type { ChatMessage } from "../../model-gateway/types.js";
import type { RequestExecutionScope } from "../request/execution-scope.js";
import type { RequestSteeringSnapshot } from "../request/request-steering.js";

export async function retrieveResponseLongTermMemory(
  request: Pick<
    RequestExecutionScope,
    | "requestId"
    | "sessionId"
    | "prompt"
    | "abortSignal"
    | "onEvent"
    | "longTermMemory"
  >,
  steering: RequestSteeringSnapshot,
): Promise<ChatMessage | undefined> {
  if (!request.longTermMemory?.enabled) {
    return undefined;
  }
  const retrieval = await request.longTermMemory.retrieve({
    query: buildMemoryRetrievalQuery(request.prompt, steering),
    context: {
      requestId: request.requestId,
      sessionId: request.sessionId,
      abortSignal: request.abortSignal,
      onEvent: request.onEvent,
    },
  });
  return retrieval.message;
}

export function buildMemoryRetrievalQuery(
  prompt: string,
  steering: RequestSteeringSnapshot,
): string {
  return [prompt, ...steering.updates.map(({ text }) => text)]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
}
