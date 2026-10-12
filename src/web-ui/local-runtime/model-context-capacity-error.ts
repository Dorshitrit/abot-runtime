import type { ModelContextCapacityIssue } from "../../runtime/config/model-context-capacity.js";
import { RuntimeConfigValidationError } from "../../runtime/config/validation.js";

export type PublicContextWindowIssue = Readonly<{
  field: "contextWindowTokens";
  declaredTokens: number;
  effectiveTokens: number;
  reservedTokens: number;
  minimumTokens: number;
  allocationTokens?: number;
  environmentId?: string;
}>;

export function readModelContextCapacityIssue(
  error: unknown,
  profileId: string,
): ModelContextCapacityIssue | undefined {
  if (!(error instanceof RuntimeConfigValidationError)) return undefined;
  return error.capacityIssues.find((issue) => issue.profileId === profileId);
}

export function modelContextCapacityMessage(
  issue: ModelContextCapacityIssue,
): string {
  const capacity = `The effective context window is ${issue.effectiveTokens} tokens, but the configured reserves require more than ${issue.reservedTokens} tokens. Use a model-supported context window of at least ${issue.minimumTokens} tokens or adjust the configured reserves.`;
  if (issue.allocationTokens === undefined) return capacity;
  if (issue.allocationTokens >= issue.minimumTokens) return capacity;
  return `${capacity} The Ollama num_ctx allocation of ${issue.allocationTokens} tokens must also support that window.`;
}

/** Project known capacity evidence without exposing config paths or raw issues. */
export function publicContextWindowIssue(
  issue: ModelContextCapacityIssue,
  environmentId?: string,
): PublicContextWindowIssue {
  return {
    field: "contextWindowTokens",
    declaredTokens: issue.declaredTokens,
    effectiveTokens: issue.effectiveTokens,
    reservedTokens: issue.reservedTokens,
    minimumTokens: issue.minimumTokens,
    ...(issue.allocationTokens === undefined
      ? {}
      : { allocationTokens: issue.allocationTokens }),
    ...(environmentId === undefined ? {} : { environmentId }),
  };
}
