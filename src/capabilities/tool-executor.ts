import { traceDebug } from "../runtime/observability/debug-logger.js";
import type {
  ToolCall,
  ToolActionSummary,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolImplementation,
  ToolImplementationOutput,
} from "./tool-types.js";

type ToolExecutorOptions = {
  implementations?: Record<string, ToolImplementation>;
  abortSignal?: AbortSignal;
  sharedState?: ToolExecutionContext["sharedState"];
  modelInvoker?: ToolExecutionContext["modelInvoker"];
  runtimePathResolver?: ToolExecutionContext["runtimePathResolver"];
};

function normalizeImplementationOutput(value: ToolImplementationOutput): {
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
    typeof value.producedNewInformation !== "boolean"
  ) {
    const error = new TypeError(
      "tool implementations must return ok, output, and producedNewInformation",
    ) as TypeError & { code: string };
    error.code = "tool_result_invalid";
    throw error;
  }
  const output = value.output;
  return {
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

function finalizeToolExecutionResult(
  result: ToolExecutionResult,
): ToolExecutionResult {
  const progress = result.ok ? result.progress : false;
  const producedNewInformation = result.ok
    ? result.producedNewInformation
    : false;
  const actions = result.actions ?? [];

  traceDebug("tools.tool-executor", "tool.progress.signal", {
    tool: result.tool,
    progress,
    producedNewInformation,
    actionCount: actions.length,
    actionTypes: actions.map((action) => action.type),
    outputLength: result.output.length,
  });

  return {
    ...result,
    progress,
    producedNewInformation,
  };
}

function createToolAbortError(reason?: unknown): Error {
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.trim().length > 0
        ? reason
        : "tool execution aborted";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function raceWithAbort<T>(
  execution: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(createToolAbortError(signal.reason));
    if (signal.aborted) {
      onAbort();
      return;
    }
    abortListener = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([execution, aborted]);
  } finally {
    if (abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

export async function executeToolCall(
  call: ToolCall,
  options: ToolExecutorOptions = {},
): Promise<ToolExecutionResult> {
  const implementations = options.implementations ?? {};
  const execute = implementations[call.tool];

  if (!execute) {
    return finalizeToolExecutionResult({
      ok: false,
      tool: call.tool,
      output: `Tool ${call.tool} not implemented`,
      progress: false,
      producedNewInformation: false,
      error: "not_implemented",
      errorCode: "not_implemented",
    });
  }

  try {
    if (options.abortSignal?.aborted) {
      throw createToolAbortError(options.abortSignal.reason);
    }
    const execution = execute(call.params, {
      abortSignal: options.abortSignal,
      sharedState: options.sharedState,
      modelInvoker: options.modelInvoker,
      runtimePathResolver: options.runtimePathResolver,
    });
    const rawOutput = options.abortSignal
      ? await raceWithAbort(execution, options.abortSignal)
      : await execution;
    const normalized = normalizeImplementationOutput(rawOutput);
    return finalizeToolExecutionResult({
      ok: normalized.ok,
      tool: call.tool,
      output: normalized.output,
      progress: normalized.progress,
      producedNewInformation: normalized.producedNewInformation,
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
    });
  } catch (error: any) {
    if (options.abortSignal?.aborted || isAbortLikeError(error)) {
      return finalizeToolExecutionResult({
        ok: false,
        tool: call.tool,
        output: "tool execution aborted",
        progress: false,
        producedNewInformation: false,
        error: "tool execution aborted",
        errorCode: "request_aborted",
      });
    }
    const message = error?.message || "tool execution failed";
    const code =
      typeof error?.code === "string" && error.code.trim()
        ? error.code
        : "tool_execution_failed";
    const data =
      error?.data && typeof error.data === "object"
        ? (error.data as ToolExecutionResult["data"])
        : undefined;
    return finalizeToolExecutionResult({
      ok: false,
      tool: call.tool,
      output: message,
      progress: false,
      producedNewInformation: false,
      error: message,
      errorCode: code,
      ...(data ? { data } : {}),
    });
  }
}
