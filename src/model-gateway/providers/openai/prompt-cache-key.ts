import { createHash } from "node:crypto";

/** Partition cache accounting without sending the conversation identifier to OpenAI. */
export function resolveOpenAIPromptCacheKey(scope: unknown): string | undefined {
  if (typeof scope !== "string") return undefined;
  if (scope.trim().length === 0) return undefined;
  const digest = createHash("sha256")
    .update("abot-prompt-cache-v1\0")
    .update(scope)
    .digest("base64url");
  return `abot-v1:${digest}`;
}
