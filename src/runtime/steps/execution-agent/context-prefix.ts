import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";

/**
 * Invocation-local ordering of exact references supplied by the EA context owner.
 * Preserve the active request and canonical call/result sequence as one block.
 * No message bytes, authority roles, admission parts or stored sources change.
 */
export function projectExecutionContextPrefix(params: Readonly<{
  context: RequestContextProjection;
  referenceMessages: readonly ChatMessage[];
  catalogMessages: readonly ChatMessage[];
  activationMessages: readonly ChatMessage[];
}>): RequestContextProjection {
  const references = new Set(params.referenceMessages);
  const activation = new Set(params.activationMessages);
  const catalogs = new Set(params.catalogMessages);
  const firstReferenceIndex = params.context.messages.findIndex((message) => references.has(message));
  if (firstReferenceIndex < 0) return params.context;
  const projectedReferences = params.context.messages.filter((message) => references.has(message));
  const fixedReferences = projectedReferences.filter(
    (message) => !activation.has(message) && !catalogs.has(message),
  );
  const projectedCatalogs = projectedReferences.filter((message) => catalogs.has(message) && !activation.has(message));
  const projectedActivation = projectedReferences.filter((message) => activation.has(message));
  const requestAndContinuation = params.context.messages.slice(firstReferenceIndex)
    .filter((message) => !references.has(message));
  return {
    ...params.context,
    messages: [
      ...params.context.messages.slice(0, firstReferenceIndex),
      ...projectedCatalogs,
      ...fixedReferences,
      ...requestAndContinuation,
      ...projectedActivation,
    ],
  };
}

/** Bind to a retained volatile reference, not a source that compaction may replace. */
export function findExecutionActivationBoundary(
  messages: readonly ChatMessage[],
  activationMessages: readonly ChatMessage[],
): ChatMessage | undefined {
  const activation = new Set(activationMessages);
  return messages.find((message) => activation.has(message));
}
