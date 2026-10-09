import type { ModelContextCapacityIssue } from "../../runtime/config/model-context-capacity.js";
import { RuntimeConfigValidationError } from "../../runtime/config/validation.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";

export type RuntimeSetupContextWindowIssue = Readonly<{
  field: "contextWindowTokens";
  declaredTokens: number;
  effectiveTokens: number;
  reservedTokens: number;
  minimumTokens: number;
  allocationTokens?: number;
  environmentId?: string;
}>;

function setupContextWindowMessage(issue: ModelContextCapacityIssue): string {
  const capacity = `The effective context window is ${issue.effectiveTokens} tokens, but the configured reserves require more than ${issue.reservedTokens} tokens. Use a model-supported context window of at least ${issue.minimumTokens} tokens or adjust the configured reserves.`;
  if (issue.allocationTokens === undefined) return capacity;
  if (issue.allocationTokens >= issue.minimumTokens) return capacity;
  return `${capacity} The Ollama num_ctx allocation of ${issue.allocationTokens} tokens must also support that window.`;
}

export class RuntimeSetupContextWindowError extends RuntimeSetupError {
  readonly contextWindow: RuntimeSetupContextWindowIssue;

  constructor(issue: ModelContextCapacityIssue, environmentId?: string) {
    super("context_window_too_small", setupContextWindowMessage(issue));
    this.contextWindow = {
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
}

function readSetupContextCapacityIssue(
  error: unknown,
): ModelContextCapacityIssue | undefined {
  if (!(error instanceof RuntimeConfigValidationError)) return undefined;
  return error.capacityIssues.find((issue) => issue.profileId === "default");
}

/** Project only known capacity evidence; other exceptions keep their redaction. */
export function throwRuntimeSetupValidationError(
  error: unknown,
  environmentId?: string,
): never {
  const issue = readSetupContextCapacityIssue(error);
  if (!issue) throw error;
  throw new RuntimeSetupContextWindowError(issue, environmentId);
}

export function runtimeSetupContextWindowErrorDetails(error: unknown): {
  contextWindow?: RuntimeSetupContextWindowIssue;
} {
  if (!(error instanceof RuntimeSetupContextWindowError)) return {};
  return { contextWindow: error.contextWindow };
}
