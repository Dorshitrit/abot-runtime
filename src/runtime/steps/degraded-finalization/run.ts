import { traceDebug } from "../../observability/debug-logger.js";
import { RequestModelStepInvoker } from "../../model/invoke-step.js";
import { resolveOutputIncompleteError } from "../../model/provider-completion.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import {
  DEGRADED_FINALIZATION_STEP_ID,
  type DegradedFinalizationInput,
} from "./contract.js";
import { buildDegradedFinalizationFallback } from "./fallback.js";
import { buildDegradedFinalizationModelInput } from "./input.js";
import { parseDegradedFinalizationPhrasing } from "./parser.js";
import { renderDegradedFinalization } from "./render.js";

export async function runDegradedFinalization(params: {
  request: RequestExecutionSeed;
  input: DegradedFinalizationInput;
}): Promise<string> {
  params.request.abortSignal.throwIfAborted();
  const fallback = buildDegradedFinalizationFallback(params.input);
  const modelInput = buildDegradedFinalizationModelInput(params);

  try {
    const config =
      params.request.runnerConfig.steps[DEGRADED_FINALIZATION_STEP_ID];
    if (!config) {
      throw new Error("missing_degraded_finalization_config");
    }
    traceDebug("runtime.degraded_finalization", "started", {
      requestId: params.request.requestId,
      configuredTimeoutMs: config.timeoutMs,
    });

    const phrasing = await new RequestModelStepInvoker(
      {
        ...params.request,
        onThinkingDelta: (delta) =>
          safely(() => params.request.onThinkingDelta(delta)),
        onThinkingTrace: (entry) =>
          safely(() => params.request.onThinkingTrace(entry)),
      },
      params.request.onEvent,
    ).invoke({
      modelStep: DEGRADED_FINALIZATION_STEP_ID,
      messages: modelInput.messages,
      format: modelInput.format,
      timeoutReason: "degraded_finalization_timeout",
      accept(text, diagnostics) {
        const incomplete = resolveOutputIncompleteError(diagnostics);
        if (incomplete) throw incomplete;
        const parsed = parseDegradedFinalizationPhrasing(text);
        if (!parsed) {
          throw new Error("invalid_degraded_finalization_output");
        }
        return parsed;
      },
    });
    params.request.abortSignal.throwIfAborted();
    const answer = renderDegradedFinalization({
      input: params.input,
      phrasing,
    });

    traceDebug("runtime.degraded_finalization", "completed", {
      requestId: params.request.requestId,
      source: "model",
      problemCode: params.input.problem.code,
      outputLength: answer.length,
    });
    return answer;
  } catch (error: unknown) {
    if (params.request.abortSignal.aborted) {
      throw error;
    }
    traceDebug("runtime.degraded_finalization", "fallback", {
      requestId: params.request.requestId,
      source: "runtime_fallback",
      problemCode: params.input.problem.code,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
      outputLength: fallback.length,
    });
    return fallback;
  }
}

function safely(callback: () => void): void {
  try {
    callback();
  } catch {
    // The final failure gate must always return a user-facing answer.
  }
}
