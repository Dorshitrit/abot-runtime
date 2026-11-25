import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";

/**
 * Invocation-local ordering of exact references supplied by the EA context owner.
 * Put the latest complete native exchange after current guidance and before supervision.
 * No message bytes, authority roles, admission parts or stored sources change.
 */
export function projectExecutionContextPrefix(params: Readonly<{
  context: RequestContextProjection;
  referenceMessages: readonly ChatMessage[];
  catalogMessages: readonly ChatMessage[];
  activationMessages: readonly ChatMessage[];
  latestContinuationGroup?: readonly ChatMessage[];
  supervisionMessage?: ChatMessage;
}>): RequestContextProjection {
  const references = new Set(params.referenceMessages);
  const activation = new Set(params.activationMessages);
  const catalogs = new Set(params.catalogMessages);
  const firstReferenceIndex = params.context.messages.findIndex((message) => references.has(message));
  if (firstReferenceIndex < 0) return params.context;
  const projectedReferences = params.context.messages.filter((message) => references.has(message));
  const projectedCatalogs = projectedReferences.filter((message) => catalogs.has(message) && !activation.has(message));
  const changingReferences = projectedReferences.filter((message) => !catalogs.has(message) && !activation.has(message));
  const projectedActivation = projectedReferences.filter((message) => activation.has(message));
  const historyPrefix = params.context.messages.slice(0, firstReferenceIndex);
  const requestAndContinuation = params.context.messages.slice(firstReferenceIndex)
    .filter((message) => !references.has(message));
  const tailLength = retainedContinuationTailLength(params.context.messages, params.latestContinuationGroup);
  const tailStart = requestAndContinuation.length - tailLength;
  const supervision = tailLength > 0 ? params.supervisionMessage : undefined;
  return {
    ...params.context,
    messages: [
      ...historyPrefix.slice(0, 1),
      ...projectedCatalogs,
      ...historyPrefix.slice(1),
      ...requestAndContinuation.slice(0, tailStart),
      ...changingReferences,
      ...projectedActivation.filter((message) => message !== supervision),
      ...requestAndContinuation.slice(tailStart),
      ...projectedActivation.filter((message) => message === supervision),
    ],
  };
}

/** Admission can replace or omit evidence. Move only an intact terminal group, by identity. */
function retainedContinuationTailLength(
  messages: readonly ChatMessage[],
  group?: readonly ChatMessage[],
): number {
  if (!group?.length || group.length > messages.length) return 0;
  const start = messages.length - group.length;
  if (!group.every((message, index) => messages[start + index] === message)) return 0;
  const members = new Set(group);
  if (messages.slice(0, start).some((message) => members.has(message))) return 0;
  return group.length;
}

/** Bind to a retained volatile reference, not a source that compaction may replace. */
export function findExecutionActivationBoundary(
  messages: readonly ChatMessage[],
  activationMessages: readonly ChatMessage[],
): ChatMessage | undefined {
  const activation = new Set(activationMessages);
  return messages.find((message) => activation.has(message));
}
