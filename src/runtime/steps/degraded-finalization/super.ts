import { RequestModelStepInvoker } from "../../model/invoke-step.js";
import { resolveOutputIncompleteError } from "../../model/provider-completion.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { ROLE_CALL_RESPONSE_MAX_LENGTH } from "../../orchestration/role-calls/index.js";
import type { RequestExecutionBudgets } from "../../orchestration/lifecycle/execution-budgets.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import { resolveRequestSteeringInbox } from "../../request/request-steering.js";
import {
  DEGRADED_FINALIZATION_STEP_ID,
  type DegradedFinalizationInput,
  type DegradedFinalizationPhrasing,
} from "./contract.js";
import { buildDegradedFinalizationFallback } from "./fallback.js";
import { buildDegradedFinalizationModelInput } from "./input.js";
import { parseDegradedFinalizationPhrasing } from "./parser.js";
import { renderDegradedFinalization } from "./render.js";
import { resolveKnownFailurePhrasing } from "./known-failure.js";

export type SuperFailureExplanation = Readonly<{
  output: string;
  source: "model" | "runtime_fallback";
  steeringVersion: number;
  secondaryCode?: string;
}>;

/** One presentation attempt; this adapter owns no request or role transition. */
export async function runSuperDegradedFinalization(params: {
  request: RequestExecutionSeed;
  input: DegradedFinalizationInput;
  error?: unknown;
  maxResponseChars: number;
  steeringVersion: number;
  readBudgets?: () => RequestExecutionBudgets;
}): Promise<SuperFailureExplanation> {
  const fallback = createSuperFailureFallback(
    params.input,
    params.steeringVersion,
  );
  if (params.request.abortSignal.aborted)
    return withSecondary(fallback, boundedSuperFailureCode(params.request.abortSignal.reason));
  const hasCurrentSteering = resolveRequestSteeringInbox(params.request.requestSteering)
    .isCurrent(params.steeringVersion);
  if (!hasCurrentSteering)
    return withSecondary(fallback, "degraded_finalization_steering_superseded");
  const knownPhrasing = resolveKnownFailurePhrasing(params.error);
  if (knownPhrasing) {
    const output = renderBoundedSuperFailure(params.input, knownPhrasing, params.maxResponseChars);
    if (!output) return withSecondary(fallback, "degraded_finalization_response_limit_invalid");
    return Object.freeze({ output, source: "runtime_fallback", steeringVersion: params.steeringVersion });
  }
  const attemptRejection = resolveSuperFailureAttemptRejection(params);
  if (attemptRejection) {
    traceDebug("runtime.degraded_finalization", "super.skipped", {
      requestId: params.request.requestId,
      primaryCode: params.input.problem.code,
      secondaryCode: attemptRejection,
      source: "runtime_fallback",
    });
    return withSecondary(fallback, attemptRejection);
  }
  try {
    const steering = resolveRequestSteeringInbox(
      params.request.requestSteering,
    ).snapshot();
    const modelInput = buildDegradedFinalizationModelInput({
      request: params.request,
      input: params.input,
      languageSampleText: steering.updates.at(-1)?.text,
    });
    const phrasing = await new RequestModelStepInvoker(
      params.request,
      params.request.onEvent,
    ).invoke({
      modelStep: DEGRADED_FINALIZATION_STEP_ID,
      messages: modelInput.messages,
      format: modelInput.format,
      boundSteeringVersion: params.steeringVersion,
      timeoutReason: "degraded_finalization_timeout",
      accept(text, diagnostics) {
        const incomplete = resolveOutputIncompleteError(diagnostics);
        if (incomplete) throw incomplete;
        const parsed = parseDegradedFinalizationPhrasing(text);
        if (!parsed) throw new Error("invalid_degraded_finalization_output");
        return parsed;
      },
    });
    if (params.request.abortSignal.aborted) return fallback;
    const output = renderBoundedSuperFailure(
      params.input,
      phrasing,
      params.maxResponseChars,
    );
    if (!output)
      return withSecondary(fallback, "degraded_finalization_response_too_long");
    return Object.freeze({
      output,
      source: "model",
      steeringVersion: params.steeringVersion,
    });
  } catch (error: unknown) {
    const secondaryCode = boundedSuperFailureCode(error);
    traceDebug("runtime.degraded_finalization", "super.fallback", {
      requestId: params.request.requestId,
      primaryCode: params.input.problem.code,
      secondaryCode,
      source: "runtime_fallback",
    });
    return withSecondary(fallback, secondaryCode);
  }
}

export function createSuperFailureFallback(
  input: DegradedFinalizationInput,
  steeringVersion: number,
): SuperFailureExplanation {
  const output = buildDegradedFinalizationFallback({
    ...input,
    progress: null,
  });
  if (!fitsSuperFailureResponse(output, ROLE_CALL_RESPONSE_MAX_LENGTH))
    throw new Error("degraded_finalization_outer_response_limit_invalid");
  return Object.freeze({ output, source: "runtime_fallback", steeringVersion });
}

export function fitsSuperFailureResponse(
  output: string,
  limit: number,
): boolean {
  if (!Number.isSafeInteger(limit)) return false;
  if (limit <= 0) return false;
  return output.length <= Math.min(limit, ROLE_CALL_RESPONSE_MAX_LENGTH);
}

export function boundedSuperFailureCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "request_failed";
  return /^[a-z][a-z0-9_]{0,159}$/iu.test(value) ? value : "request_failed";
}

function resolveSuperFailureAttemptRejection(params: {
  request: RequestExecutionSeed;
  input: DegradedFinalizationInput;
  maxResponseChars: number;
  steeringVersion: number;
  readBudgets?: () => RequestExecutionBudgets;
}): string | undefined {
  const config =
    params.request.runnerConfig.steps[DEGRADED_FINALIZATION_STEP_ID];
  if (!config) return "missing_degraded_finalization_config";
  if (!Number.isFinite(config.timeoutMs))
    return "degraded_finalization_timeout_invalid";
  if (config.timeoutMs <= 0) return "degraded_finalization_timeout_invalid";
  if (hasExpiredRequestBudget(params.readBudgets?.()))
    return "request_deadline_exhausted";
  if (
    !fitsSuperFailureResponse(
      createSuperFailureFallback(params.input, params.steeringVersion).output,
      params.maxResponseChars,
    )
  )
    return "degraded_finalization_response_limit_invalid";
  return undefined;
}

function hasExpiredRequestBudget(
  budgets: RequestExecutionBudgets | undefined,
): boolean {
  if (!budgets) return false;
  if (budgets.requestTimeoutMs > 0 && budgets.requestRemainingMs <= 0)
    return true;
  return budgets.inactivityTimeoutMs > 0 && budgets.inactivityRemainingMs <= 0;
}

function renderBoundedSuperFailure(
  input: DegradedFinalizationInput,
  phrasing: DegradedFinalizationPhrasing,
  limit: number,
): string | undefined {
  const complete = renderDegradedFinalization({ input, phrasing });
  if (fitsSuperFailureResponse(complete, limit)) return complete;
  const withoutProgress = renderDegradedFinalization({
    input: { ...input, progress: null },
    phrasing,
  });
  return fitsSuperFailureResponse(withoutProgress, limit)
    ? withoutProgress
    : undefined;
}

function withSecondary(
  explanation: SuperFailureExplanation,
  secondaryCode: string,
): SuperFailureExplanation {
  return Object.freeze({ ...explanation, secondaryCode });
}
