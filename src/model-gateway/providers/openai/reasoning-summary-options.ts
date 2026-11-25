import { ModelReasoningConfigurationError } from "../../../shared/model-reasoning.js";
import type { ResolvedModelInvocation } from "../../types.js";

export type OpenAIReasoningSummary = "auto" | "concise" | "detailed";

export function isOpenAIReasoningSummary(value: unknown): value is OpenAIReasoningSummary {
  return value === "auto" || value === "concise" || value === "detailed";
}

function readOpenAIReasoningControls(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const reasoning = payload.reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return undefined;
  return reasoning as Record<string, unknown>;
}

/** Summary support is an explicit profile opt-in, independent of effort controls. */
export function resolveOpenAIReasoningSummary(
  invocation: ResolvedModelInvocation,
): OpenAIReasoningSummary | undefined {
  if (invocation.profile.provider !== "openai") return undefined;
  const configured = invocation.profile.options.reasoningSummary;
  if (configured === undefined || configured === null) return undefined;
  if (!isOpenAIReasoningSummary(configured)) {
    throw new ModelReasoningConfigurationError(
      "invalid_openai_reasoning_summary",
      "options.reasoningSummary must be auto, concise, detailed, null, or omitted",
    );
  }
  if (invocation.think === "none") return undefined;
  return configured;
}

export function requestsOpenAIReasoningSummary(
  invocation: ResolvedModelInvocation,
  payload: Record<string, unknown>,
): boolean {
  if (invocation.profile.provider !== "openai") return false;
  return isOpenAIReasoningSummary(readOpenAIReasoningControls(payload)?.summary);
}

/** Input counting does not generate a summary; preserve all remaining controls. */
export function omitOpenAIReasoningSummary(payload: Record<string, unknown>): void {
  const controls = readOpenAIReasoningControls(payload);
  if (!controls) return;
  delete controls.summary;
  if (Object.keys(controls).length === 0) delete payload.reasoning;
}
