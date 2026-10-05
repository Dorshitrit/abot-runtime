import type { ToolImplementationOutput } from "../plugin-contract/entrypoint.js";
import { hasValidToolContextText } from "../capabilities/tool-context-text.js";
import {
  CAPABILITY_RESULT_ENVELOPE_MAX_BYTES,
  type ToolResultBudget,
} from "../capabilities/result-budget.js";
export type {
  ToolResultBudget,
  ToolResultBudgetAssessment,
} from "../capabilities/result-budget.js";

import {
  isPluginParameterError,
  type PluginParameterErrorCode,
} from "./parameters.js";
import { runtimeToolPathErrorCode } from "./paths.js";

type ResultCommon = Pick<
  ToolImplementationOutput,
  | "actions"
  | "data"
  | "exitCode"
  | "progress"
  | "stderr"
  | "stdout"
  | "media"
>;

/** Legacy standalone SDK bound; invocation-aware producers also pass the host assessor. */
export const PLUGIN_RESULT_SERIALIZED_MAX_BYTES =
  CAPABILITY_RESULT_ENVELOPE_MAX_BYTES;

function resultBoundsFailure(code: string, message: string) {
  return {
    ok: false as const,
    output: message,
    producedNewInformation: false,
    error: message,
    errorCode: code,
  };
}

export function enforcePluginResultByteBudget(
  result: ToolImplementationOutput,
  resultBudget?: ToolResultBudget,
): ToolImplementationOutput {
  let requiresContextTextHost = false;
  let serializedBytes: number;
  let envelopeBytes: number;
  let maxBytes = PLUGIN_RESULT_SERIALIZED_MAX_BYTES;
  let fitsDeclaredBudget = true;
  try {
    if (!hasValidToolContextText(result)) {
      return resultBoundsFailure(
        "plugin_context_text_invalid",
        "The plugin declared invalid context text fields.",
      );
    }
    requiresContextTextHost = result.contextTextFields !== undefined;
    const lacksContextTextHost =
      requiresContextTextHost && resultBudget?.acceptsContextText !== true;
    if (lacksContextTextHost) {
      return resultBoundsFailure(
        "plugin_context_text_unavailable",
        "The host does not support context-managed tool text.",
      );
    }
    const candidate = JSON.stringify(result);
    if (candidate === undefined) {
      return resultBoundsFailure(
        "plugin_result_not_json_safe",
        "The plugin produced a result that is not JSON-safe.",
      );
    }
    const assessment = resultBudget?.assess(result);
    serializedBytes =
      assessment?.serializedBytes ?? Buffer.byteLength(candidate, "utf8");
    envelopeBytes = assessment?.envelopeBytes ?? serializedBytes;
    maxBytes = Math.min(assessment?.maxBytes ?? maxBytes, maxBytes);
    fitsDeclaredBudget = assessment?.fits ?? true;
  } catch {
    return resultBoundsFailure(
      "plugin_result_not_json_safe",
      "The plugin produced a result that is not JSON-safe.",
    );
  }
  const hasResultDeliveryHeadroom =
    fitsDeclaredBudget && envelopeBytes <= maxBytes;
  if (!hasResultDeliveryHeadroom) {
    const message = requiresContextTextHost
      ? `The plugin result envelope is ${envelopeBytes} bytes (${serializedBytes} total bytes) and exceeds the ${maxBytes}-byte delivery limit.`
      : `The plugin result is ${serializedBytes} bytes and exceeds the ${maxBytes}-byte delivery limit.`;
    return resultBoundsFailure("plugin_result_too_large", message);
  }
  return result;
}

export type SuccessResultInput = ResultCommon &
  Readonly<{
    output: string;
    producedNewInformation?: boolean;
  }>;

export function successResult(
  input: SuccessResultInput,
  resultBudget?: ToolResultBudget,
): ToolImplementationOutput {
  return enforcePluginResultByteBudget(
    {
      ok: true,
      ...(input.media !== undefined ? { media: input.media } : {}),
      output: input.output,
      producedNewInformation: input.producedNewInformation ?? true,
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.actions !== undefined ? { actions: input.actions } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
      ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
    },
    resultBudget,
  );
}

export type FailureResultInput = ResultCommon &
  Readonly<{
    interruption?: ToolImplementationOutput["interruption"];
    errorCode: string;
    message: string;
    output?: string;
  }>;

export function failureResult(
  input: FailureResultInput,
  resultBudget?: ToolResultBudget,
): ToolImplementationOutput {
  return enforcePluginResultByteBudget(
    {
      ok: false,
      ...(input.interruption ? { interruption: input.interruption } : {}),
      ...(input.media !== undefined ? { media: input.media } : {}),
      output: input.output ?? input.message,
      producedNewInformation: false,
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.actions !== undefined ? { actions: input.actions } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
      ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
      error: input.message,
      errorCode: input.errorCode,
    },
    resultBudget,
  );
}

export function failureFromError(
  error: unknown,
  options: Readonly<{
    fallbackCode: string;
    fallbackMessage: string;
    operation?: string;
  }>,
): ToolImplementationOutput {
  const pathCode = runtimeToolPathErrorCode(error);
  const parameterCode: PluginParameterErrorCode | undefined =
    isPluginParameterError(error) ? error.code : undefined;
  const errorCode = pathCode ?? parameterCode ?? options.fallbackCode;
  const message = pathCode ?? parameterCode ?? options.fallbackMessage;
  return failureResult({
    errorCode,
    message,
    output: options.operation
      ? `${options.operation} failed: ${message}`
      : message,
  });
}
