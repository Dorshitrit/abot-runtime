import type { SessionMessage } from "../types.js";

export const EXECUTION_TOOL_OBSERVATION_KIND =
  "runtime_execution_tool_observation_v1" as const;

export type ExecutionToolObservation = Readonly<{
  kind: typeof EXECUTION_TOOL_OBSERVATION_KIND;
  requestId: string;
  results: readonly unknown[];
}>;

export function readExecutionToolObservation(
  message: Pick<SessionMessage, "requestId" | "observationContent">,
): ExecutionToolObservation | undefined {
  if (typeof message.requestId !== "string") return undefined;
  if (message.requestId.trim().length === 0) return undefined;
  if (!message.observationContent) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(message.observationContent);
  } catch {
    return undefined;
  }
  if (!isBoundExecutionToolObservation(decoded, message.requestId)) return undefined;
  return Object.freeze({
    kind: EXECUTION_TOOL_OBSERVATION_KIND,
    requestId: decoded.requestId,
    results: Object.freeze([...decoded.results]),
  });
}

export function projectExecutionHistoryContent(message: SessionMessage): string {
  if (message.role !== "assistant") return message.content;
  const observation = readExecutionToolObservation(message);
  if (!observation) return message.content;
  return JSON.stringify({
    kind: "runtime_execution_history_turn_v1",
    authority: "prior_conversation",
    purpose: "reuse_previously_collected_tool_results_for_follow_up",
    requestId: observation.requestId,
    assistantResponse: message.content,
    toolObservation: observation,
    presenceEffect:
      "passive_history_not_current_intent_work_authorization_or_current_completion_evidence",
  });
}

function isBoundExecutionToolObservation(
  value: unknown,
  requestId: string,
): value is ExecutionToolObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const observation = value as Record<string, unknown>;
  if (observation.kind !== EXECUTION_TOOL_OBSERVATION_KIND) return false;
  if (observation.requestId !== requestId) return false;
  if (!Array.isArray(observation.results)) return false;
  return observation.results.length > 0;
}
