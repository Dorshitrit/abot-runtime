import { MODEL_STEPS } from "../../../shared/model-steps.js";
import type { ModelGatewayRequest, ModelProfile } from "../../types.js";

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** An explicit operator declaration of support; model names are not capabilities. */
export function isOpenAIPromptCacheEnabled(options: Readonly<Record<string, unknown>>): boolean {
  const configured = readRecord(options.prompt_cache_options);
  return configured?.mode === "implicit" && Object.keys(configured).length === 1;
}

export function resolveOpenAIPromptCacheBoundary(
  request: ModelGatewayRequest,
  profile: Pick<ModelProfile, "provider" | "options">,
): number | undefined {
  if (profile.provider !== "openai") return undefined;
  if (request.modelStep !== MODEL_STEPS.EXECUTION_DECISION) return undefined;
  if (!isOpenAIPromptCacheEnabled(profile.options)) return undefined;
  const index = request.promptCacheBoundaryBeforeMessageIndex;
  if (typeof index !== "number" || !Number.isSafeInteger(index)) return undefined;
  if (!Array.isArray(request.messages) || index <= 0 || index >= request.messages.length) return undefined;
  return index;
}

function promptCacheContentField(item: Record<string, unknown>): "output" | "content" | undefined {
  if (item.type === "function_call_output") return "output";
  if (item.role === "user" || item.role === "system" || item.role === "developer") return "content";
  return undefined;
}

function isSupportedPromptCacheBlock(block: Record<string, unknown> | undefined): boolean {
  return block?.type === "input_text" || block?.type === "input_image";
}

/** Keep earlier endpoints identical when the marker advances on a later activation. */
export function normalizeOpenAIPromptCacheItem(value: unknown): unknown {
  const item = readRecord(value);
  if (!item) return value;
  const field = promptCacheContentField(item);
  if (!field || typeof item[field] !== "string") return value;
  return { ...item, [field]: [{ type: "input_text", text: item[field] }] };
}

/** Marks only supported final blocks, without mutating canonical messages or pixels. */
export function markOpenAIPromptCacheItem(value: unknown): Record<string, unknown> | undefined {
  const item = readRecord(normalizeOpenAIPromptCacheItem(value));
  if (!item) return undefined;
  const field = promptCacheContentField(item);
  if (!field) return undefined;
  const content = item[field];
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const last = readRecord(content[content.length - 1]);
  if (!isSupportedPromptCacheBlock(last)) return undefined;
  return {
    ...item,
    [field]: [...content.slice(0, -1), { ...last, prompt_cache_breakpoint: { mode: "explicit" } }],
  };
}
