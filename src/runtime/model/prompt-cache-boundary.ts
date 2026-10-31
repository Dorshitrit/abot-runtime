import type { ChatMessage } from "../../model-gateway/types.js";

/** Resolve the caller-owned boundary only after each candidate's final projection. */
export function projectPromptCacheBoundary(params: Readonly<{
  messages: readonly ChatMessage[];
  beforeMessage?: ChatMessage;
}>): Readonly<{ promptCacheBoundaryBeforeMessageIndex?: number }> {
  if (!params.beforeMessage) return {};
  const index = params.messages.indexOf(params.beforeMessage);
  if (index <= 0) return {};
  if (params.messages.lastIndexOf(params.beforeMessage) !== index) return {};
  return { promptCacheBoundaryBeforeMessageIndex: index };
}
