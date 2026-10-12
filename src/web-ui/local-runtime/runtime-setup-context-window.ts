import type { ModelContextCapacityIssue } from "../../runtime/config/model-context-capacity.js";
import { RuntimeSetupError } from "./runtime-setup-input.js";
import {
  modelContextCapacityMessage,
  publicContextWindowIssue,
  readModelContextCapacityIssue,
  type PublicContextWindowIssue,
} from "./model-context-capacity-error.js";

export type RuntimeSetupContextWindowIssue = PublicContextWindowIssue;

export class RuntimeSetupContextWindowError extends RuntimeSetupError {
  readonly contextWindow: RuntimeSetupContextWindowIssue;

  constructor(issue: ModelContextCapacityIssue, environmentId?: string) {
    super("context_window_too_small", modelContextCapacityMessage(issue));
    this.contextWindow = publicContextWindowIssue(issue, environmentId);
  }
}

/** Project only known capacity evidence; other exceptions keep their redaction. */
export function throwRuntimeSetupValidationError(
  error: unknown,
  environmentId?: string,
): never {
  const issue = readModelContextCapacityIssue(error, "default");
  if (!issue) throw error;
  throw new RuntimeSetupContextWindowError(issue, environmentId);
}

export function runtimeSetupContextWindowErrorDetails(error: unknown): {
  contextWindow?: RuntimeSetupContextWindowIssue;
} {
  if (!(error instanceof RuntimeSetupContextWindowError)) return {};
  return { contextWindow: error.contextWindow };
}
