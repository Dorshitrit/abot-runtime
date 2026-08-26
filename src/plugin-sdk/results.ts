import type { ToolImplementationOutput } from "../plugin-contract/entrypoint.js";

import {
  isPluginParameterError,
  type PluginParameterErrorCode,
} from "./parameters.js";
import { runtimeToolPathErrorCode } from "./paths.js";

type ResultCommon = Pick<
  ToolImplementationOutput,
  "actions" | "data" | "exitCode" | "progress" | "stderr" | "stdout"
>;

export const PLUGIN_RESULT_SERIALIZED_MAX_BYTES = 128 * 1024;

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
): ToolImplementationOutput {
  let serialized: string;
  try {
    const candidate = JSON.stringify(result);
    if (candidate === undefined) {
      return resultBoundsFailure(
        "plugin_result_not_json_safe",
        "The plugin produced a result that is not JSON-safe.",
      );
    }
    serialized = candidate;
  } catch {
    return resultBoundsFailure(
      "plugin_result_not_json_safe",
      "The plugin produced a result that is not JSON-safe.",
    );
  }
  if (
    Buffer.byteLength(serialized, "utf8") > PLUGIN_RESULT_SERIALIZED_MAX_BYTES
  ) {
    return resultBoundsFailure(
      "plugin_result_too_large",
      `The plugin result exceeds the ${PLUGIN_RESULT_SERIALIZED_MAX_BYTES}-byte safety limit.`,
    );
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
): ToolImplementationOutput {
  return enforcePluginResultByteBudget({
    ok: true,
    output: input.output,
    producedNewInformation: input.producedNewInformation ?? true,
    ...(input.progress !== undefined ? { progress: input.progress } : {}),
    ...(input.actions !== undefined ? { actions: input.actions } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
    ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
  });
}

export type FailureResultInput = ResultCommon &
  Readonly<{
    errorCode: string;
    message: string;
    output?: string;
  }>;

export function failureResult(
  input: FailureResultInput,
): ToolImplementationOutput {
  return enforcePluginResultByteBudget({
    ok: false,
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
  });
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
