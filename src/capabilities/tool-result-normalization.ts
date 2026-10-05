import { isToolResultMedia } from "./tool-media.js";
import { hasValidToolContextText } from "./tool-context-text.js";
import type {
  ToolImplementationOutput,
  ToolExecutionResult,
  ToolActionSummary,
} from "./tool-types.js";

export function normalizeImplementationOutput(
  value: ToolImplementationOutput,
): {
  contextTextFields?: ToolImplementationOutput["contextTextFields"];
  interruption?: ToolImplementationOutput["interruption"];
  media?: ToolImplementationOutput["media"];
  ok: boolean;
  output: string;
  progress: boolean;
  producedNewInformation: boolean;
  actions?: ToolActionSummary[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  data?: ToolExecutionResult["data"];
  error?: string;
  errorCode?: string;
} {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof value.ok !== "boolean" ||
    typeof value.output !== "string" ||
    typeof value.producedNewInformation !== "boolean" ||
    !isToolResultMedia(value.media) ||
    !hasValidToolContextText(value)
  ) {
    const error = new TypeError(
      "tool implementations must return ok, output, and producedNewInformation",
    ) as TypeError & { code: string };
    error.code = "tool_result_invalid";
    throw error;
  }
  const output = value.output;
  const hasFailedInterruption = !value.ok && value.interruption === "aborted";
  return {
    ...(value.contextTextFields
      ? { contextTextFields: Object.freeze([...value.contextTextFields]) }
      : {}),
    ...(hasFailedInterruption ? { interruption: value.interruption } : {}),
    ...(value.media ? { media: value.media } : {}),
    ok: value.ok,
    output,
    progress: value.progress === true,
    producedNewInformation: value.producedNewInformation === true,
    actions: Array.isArray(value.actions) ? value.actions : undefined,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
    stdout: typeof value.stdout === "string" ? value.stdout : undefined,
    stderr: typeof value.stderr === "string" ? value.stderr : undefined,
    data: value.data,
    error: typeof value.error === "string" ? value.error : undefined,
    errorCode:
      typeof value.errorCode === "string" ? value.errorCode : undefined,
  };
}

export function projectToolExecutionResult(
  tool: string,
  rawOutput: ToolImplementationOutput,
): ToolExecutionResult {
  const normalized = normalizeImplementationOutput(rawOutput);
  return {
    ok: normalized.ok,
    ...(normalized.contextTextFields
      ? { contextTextFields: normalized.contextTextFields }
      : {}),
    ...(normalized.interruption
      ? { interruption: normalized.interruption }
      : {}),
    tool,
    output: normalized.output,
    progress: normalized.ok ? normalized.progress : false,
    producedNewInformation: normalized.ok
      ? normalized.producedNewInformation
      : false,
    ...(normalized.media ? { media: normalized.media } : {}),
    ...(normalized.actions ? { actions: normalized.actions } : {}),
    ...(typeof normalized.exitCode === "number"
      ? { exitCode: normalized.exitCode }
      : {}),
    ...(typeof normalized.stdout === "string"
      ? { stdout: normalized.stdout }
      : {}),
    ...(typeof normalized.stderr === "string"
      ? { stderr: normalized.stderr }
      : {}),
    ...(normalized.data ? { data: normalized.data } : {}),
    ...(normalized.error ? { error: normalized.error } : {}),
    ...(normalized.errorCode ? { errorCode: normalized.errorCode } : {}),
  };
}
