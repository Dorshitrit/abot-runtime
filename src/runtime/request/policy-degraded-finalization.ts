import type { DegradedFinalizationInput } from "../steps/degraded-finalization/contract.js";
import { runDegradedFinalization } from "../steps/degraded-finalization/run.js";
import { fitsSuperFailureResponse } from "../steps/degraded-finalization/super.js";
import type { RequestExecutionScope } from "./execution-scope.js";
import type { RequestRunnerResult } from "./result.js";

/** Existing policy gate; EA retains its original single-step supervision path. */
export async function runPolicyDegradedFinalization(params: {
  request: RequestExecutionScope;
  input: DegradedFinalizationInput;
  maxResponseChars: number;
}): Promise<string> {
  const finalization = params.request.superFailureFinalization;
  if (!finalization) return runDegradedFinalization(params);
  const error = new Error(params.input.problem.code);
  const result = await finalization.explain({
    error,
    input: params.input,
    maxResponseChars: params.maxResponseChars,
  });
  if (!fitsSuperFailureResponse(result.output, params.maxResponseChars))
    throw error;
  return result.output;
}

export function projectPolicyDegradedResult(
  request: RequestExecutionScope,
  output: string,
): RequestRunnerResult {
  if (request.superFailureFinalization)
    return { output, disposition: "blocked" };
  return {
    output,
    ...(request.executionPolicy.authority.terminalTextMode === "exact"
      ? { outputTextMode: "exact" as const }
      : {}),
  };
}
