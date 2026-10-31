import { resolveModelOutputFailure } from "../../model/invalid-output-failure.js";
import { projectOutputLimitCause } from "./output-limit-cause.js";
import type { DegradedFinalizationInput, DegradedFinalizationPhrasing } from "./contract.js";
import { renderDegradedFinalization } from "./render.js";
import { readModelGatewayUserMessage } from "../../../model-gateway/client.js";

const WORKING_DIRECTORY_ISSUES = new Set([
  "supervisor_working_directory_invalid",
  "execution_agent_working_directory_invalid",
  "planner_working_directory_invalid",
]);

/** Only typed, validated failures establish a cause; arbitrary error text cannot. */
export function resolveKnownFailurePhrasing(error: unknown): DegradedFinalizationPhrasing | undefined {
  const providerMessage = readModelGatewayUserMessage(error);
  if (providerMessage) return { failureNotice: providerMessage, nextStep: "" };
  if (projectOutputLimitCause(error)) {
    return {
      failureNotice: "The model reached its output-token limit before finishing its decision or response.",
      nextStep: "Review the selected model and reasoning settings before continuing.",
    };
  }
  const failure = resolveModelOutputFailure(error);
  if (!failure) return undefined;
  const hasWorkingDirectoryFailure = failure.issues.some(({ code }) => WORKING_DIRECTORY_ISSUES.has(code));
  if (hasWorkingDirectoryFailure) {
    return {
      failureNotice: "ABot could not use the working directory selected by the model.",
      nextStep: "Select an available project folder, or add the folder in Projects, then try again.",
    };
  }
  return {
    failureNotice: "ABot could not complete the request because the model returned an invalid decision or response.",
    nextStep: "Try again or choose a different model. Any work already performed still needs to be checked.",
  };
}

export function renderKnownDegradedFailure(params: {
  error?: unknown;
  input: DegradedFinalizationInput;
  maxResponseChars: number;
}): string | undefined {
  const phrasing = resolveKnownFailurePhrasing(params.error);
  if (!phrasing) return undefined;
  const output = renderDegradedFinalization({ input: params.input, phrasing });
  const exceedsResponseLimit = output.length > params.maxResponseChars;
  if (exceedsResponseLimit)
    throw params.error;
  return output;
}
