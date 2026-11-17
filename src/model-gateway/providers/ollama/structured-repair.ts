import { isPlainObject } from "../../structured-output/format-contract.js";
import type { ResolvedModelInvocation } from "../../types.js";

type OllamaStructuredRepairContext = Readonly<{
  structuredOutputRepair: unknown;
  projectedFormat: unknown;
  requestedThinking: ResolvedModelInvocation["think"];
  canDisableThinking?: boolean;
}>;

/** The existing repair attempt owns the retry; this only changes its generation mode. */
export function shouldDisableOllamaThinkingForStructuredRepair(
  params: OllamaStructuredRepairContext,
): boolean {
  if (params.canDisableThinking === false) return false;
  if (params.structuredOutputRepair !== "json_schema_violation") return false;
  if (!isPlainObject(params.projectedFormat)) return false;
  if (params.requestedThinking === undefined) return false;
  return params.requestedThinking !== "none";
}

export function resolveOllamaChatThinking(
  params: OllamaStructuredRepairContext,
): ResolvedModelInvocation["think"] | false {
  if (shouldDisableOllamaThinkingForStructuredRepair(params)) return false;
  if (params.requestedThinking === "none") return false;
  return params.requestedThinking;
}

export function resolveOllamaRawThinking(invocation: ResolvedModelInvocation): ResolvedModelInvocation["think"] | false {
  if (invocation.parameters?.canDisableThinking === false) return invocation.think;
  if (invocation.parameters?.controls.reasoning_effort) return invocation.think === "none" ? false : invocation.think;
  return false;
}

/** Bounded projection of requested/effective settings, without model output or history. */
export function projectOllamaThinkingDiagnostics(
  params: OllamaStructuredRepairContext & Readonly<{
    endpoint: "chat" | "raw";
    effectiveThinking: unknown;
  }>,
): Record<string, unknown> {
  const diagnostics = {
    requestedThinking: params.requestedThinking ?? null,
    effectiveThinking: params.effectiveThinking ?? null,
  };
  if (params.endpoint !== "chat") return diagnostics;
  if (params.effectiveThinking !== false) return diagnostics;
  if (!shouldDisableOllamaThinkingForStructuredRepair(params)) return diagnostics;
  return {
    ...diagnostics,
    thinkingOverrideReason: "structured_output_schema_repair",
  };
}
