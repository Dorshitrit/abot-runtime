import { traceDebug } from "../runtime/observability/debug-logger.js";
import { normalizeImplementationOutput, projectToolExecutionResult } from "./tool-result-normalization.js";
import type {
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolImplementation,
  ToolImplementationOutput,
  ToolUnderlyingSettlement,
} from "./tool-types.js";

type ToolExecutorOptions = {
  executionAuthority?: ToolExecutionContext["executionAuthority"];
  requestWork?: ToolExecutionContext["requestWork"];
  requestState?: ToolExecutionContext["requestState"];
  media?: ToolExecutionContext["media"];
  resultBudget?: ToolExecutionContext["resultBudget"];
  onRequestDispose?: ToolExecutionContext["onRequestDispose"];
  implementations?: Record<string, ToolImplementation>;
  abortSignal?: AbortSignal;
  sharedState?: ToolExecutionContext["sharedState"];
  modelInvoker?: ToolExecutionContext["modelInvoker"];
  runtimePathResolver?: ToolExecutionContext["runtimePathResolver"];
  reportFileOutput?: ToolExecutionContext["reportFileOutput"];
  onUnderlyingSettlement?: (settled: Promise<ToolUnderlyingSettlement>) => void;
};

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value)
    ? value
    : "tool_execution_failed";
}

function underlyingSettlement(
  execution: Promise<ToolImplementationOutput>,
): Promise<ToolUnderlyingSettlement> {
  return execution.then(
    (raw) => {
      try {
        const output = normalizeImplementationOutput(raw);
        return {
          status: "fulfilled" as const,
          ok: output.ok,
          ...(output.errorCode ? { errorCode: safeErrorCode(output.errorCode) } : {}),
        };
      } catch (error) {
        return { status: "rejected" as const, errorCode: safeErrorCode((error as { code?: unknown })?.code) };
      }
    },
    (error) => ({
      status: "rejected" as const,
      errorCode: safeErrorCode((error as { code?: unknown })?.code),
    }),
  );
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
      executionAuthority: options.executionAuthority,
      requestWork: options.requestWork,
      requestState: options.requestState,
      media: options.media,
      resultBudget: options.resultBudget,
      onRequestDispose: options.onRequestDispose,
      abortSignal: options.abortSignal,
      sharedState: options.sharedState,
      modelInvoker: options.modelInvoker,
      runtimePathResolver: options.runtimePathResolver,
      reportFileOutput: options.reportFileOutput,
    });
    // The public result may win the abort race while the implementation still
    // owns a live external effect. Automation admission tracks that promise.
    options.onUnderlyingSettlement?.(underlyingSettlement(execution));
    const rawOutput = options.abortSignal
      ? await raceWithAbort(execution, options.abortSignal)
      : await execution;
    return finalizeToolExecutionResult(projectToolExecutionResult(call.tool, rawOutput));
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
        interruption: "aborted",
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
