import type { ModelContextCapacityIssue } from "../../runtime/config/model-context-capacity.js";
import { ModelSetupError } from "./model-setup-input.js";
import {
  modelContextCapacityMessage,
  publicContextWindowIssue,
  readModelContextCapacityIssue,
  type PublicContextWindowIssue,
} from "./model-context-capacity-error.js";

type ModelSetupContextWindowIssue = PublicContextWindowIssue &
  Readonly<{ profileId: string }>;

export class ModelSetupContextWindowError extends ModelSetupError {
  readonly contextWindow: ModelSetupContextWindowIssue;

  constructor(issue: ModelContextCapacityIssue, environmentId?: string) {
    super("context_window_too_small", modelContextCapacityMessage(issue));
    this.contextWindow = {
      ...publicContextWindowIssue(issue, environmentId),
      profileId: issue.profileId,
    };
  }
}

export function throwModelSetupValidationError(
  error: unknown,
  profileId: string | undefined,
  environmentId?: string,
): never {
  if (profileId === undefined) throw error;
  const issue = readModelContextCapacityIssue(error, profileId);
  if (!issue) throw error;
  throw new ModelSetupContextWindowError(issue, environmentId);
}

export function modelSetupContextWindowErrorDetails(error: unknown): {
  contextWindow?: ModelSetupContextWindowIssue;
} {
  if (!(error instanceof ModelSetupContextWindowError)) return {};
  return { contextWindow: error.contextWindow };
}
