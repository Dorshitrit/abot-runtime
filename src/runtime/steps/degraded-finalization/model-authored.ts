import {
  invokeStructuredModelStep,
  type StructuredModelParseResult,
} from "../../model/invoke-structured-step.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type {
  BoundRequestModelInvocationContext,
  RequestExecutionSeed,
} from "../../request/contracts.js";
import {
  DEGRADED_FINALIZATION_STEP_ID,
  type DegradedFinalizationInput,
} from "./contract.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import { buildDegradedFinalizationModelInput } from "./input.js";
import { parseDegradedFinalizationPhrasing } from "./parser.js";
import { renderDegradedFinalization } from "./render.js";

/** Requires model-authored framing; failure never substitutes runtime prose. */
export async function runModelAuthoredDegradedFinalization(params: {
  request: RequestExecutionSeed & BoundRequestModelInvocationContext;
  input: DegradedFinalizationInput;
  maxResponseChars: number;
}): Promise<string> {
  params.request.abortSignal.throwIfAborted();
  if (!isUsableDegradedResponseLimit(params.maxResponseChars)) {
    throw new Error("degraded_finalization_response_limit_invalid");
  }
  const steering = resolveRequestSteeringInbox(
    params.request.requestSteering,
  ).snapshot();
  const modelInput = buildDegradedFinalizationModelInput({
    ...params,
    languageSampleText: steering.updates.at(-1)?.text,
  });
  traceDebug("runtime.degraded_finalization", "started", {
    requestId: params.request.requestId,
    problemCode: params.input.problem.code,
    source: "model_required",
  });
  try {
    const response = await invokeStructuredModelStep<string>({
      request: params.request,
      modelStep: DEGRADED_FINALIZATION_STEP_ID,
      messages: modelInput.messages,
      format: modelInput.format,
      timeoutReason: "degraded_finalization_timeout",
      invalidOutputReason: "invalid_degraded_finalization_output",
      parse: (text) => parseBoundedDegradedResponse(text, params),
    });
    params.request.abortSignal.throwIfAborted();
    traceDebug("runtime.degraded_finalization", "completed", {
      requestId: params.request.requestId,
      problemCode: params.input.problem.code,
      source: "model",
      outputLength: response.length,
    });
    return response;
  } catch (error: unknown) {
    traceDebug("runtime.degraded_finalization", "failed", {
      requestId: params.request.requestId,
      problemCode: params.input.problem.code,
      source: "model_required",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function parseBoundedDegradedResponse(
  text: string,
  params: { input: DegradedFinalizationInput; maxResponseChars: number },
): StructuredModelParseResult<string> {
  const phrasing = parseDegradedFinalizationPhrasing(text);
  if (!phrasing) {
    return rejectedDegradedResponse(
      "degraded_finalization_phrasing_invalid",
      "Return the required failureNotice and nextStep as non-empty strings.",
    );
  }
  const response = renderDegradedFinalization({
    input: params.input,
    phrasing,
  });
  if (!fitsDegradedResponseLimit(response, params.maxResponseChars)) {
    return rejectedDegradedResponse(
      "degraded_finalization_response_too_long",
      `Shorten the framing so the complete response, including recorded progress, fits within ${params.maxResponseChars} characters.`,
    );
  }
  return { ok: true, decision: response };
}

function rejectedDegradedResponse(
  code: string,
  message: string,
): StructuredModelParseResult<string> {
  return {
    ok: false,
    stage: "degraded_finalization",
    issues: [{ code, path: "$", message }],
  };
}

function isUsableDegradedResponseLimit(maxResponseChars: number): boolean {
  if (!Number.isSafeInteger(maxResponseChars)) return false;
  return maxResponseChars > 0;
}

function fitsDegradedResponseLimit(
  response: string,
  maxResponseChars: number,
): boolean {
  return response.length <= maxResponseChars;
}
