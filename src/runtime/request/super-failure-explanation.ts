import { hasSuperContextContract } from "../context/super-context-policy.js";
import type { RequestExecutionBudgets } from "../orchestration/lifecycle/execution-budgets.js";
import type { DegradedFinalizationInput } from "../steps/degraded-finalization/contract.js";
import { projectOutputLimitCause } from "../steps/degraded-finalization/output-limit-cause.js";
import {
  boundedSuperFailureCode,
  createSuperFailureFallback,
  runSuperDegradedFinalization,
  type SuperFailureExplanation,
} from "../steps/degraded-finalization/super.js";
import type { RequestExecutionSeed } from "./contracts.js";
import type { CompiledRequestExecutionPolicy } from "./execution-scope.js";
import { resolveRequestSteeringInbox } from "./request-steering.js";

export type SuperFailureFinalization = Readonly<{
  agentMode: RequestExecutionSeed["agentMode"];
  remember(error: unknown, stage: string): void;
  primaryError(): unknown;
  explain(params: {
    error: unknown;
    input: DegradedFinalizationInput;
    maxResponseChars: number;
    steeringVersion?: number;
  }): Promise<SuperFailureExplanation>;
}>;

/** Activation-local authoring cache only; lifecycle/persistence stay with their owners. */
export function createSuperFailureFinalization(params: {
  request: RequestExecutionSeed;
  executionPolicy: CompiledRequestExecutionPolicy;
  readBudgets?: () => RequestExecutionBudgets;
}): SuperFailureFinalization | undefined {
  if (
    !hasSuperContextContract(
      params.executionPolicy.authority,
      params.executionPolicy.rootContract.contractId,
    )
  )
    return undefined;
  const request = projectTrustedFailureRequest(params.request);
  const steering = resolveRequestSteeringInbox(request.requestSteering);
  let primary:
    | Readonly<{ error: unknown; stage: string; code: string }>
    | undefined;
  let attempt: Promise<SuperFailureExplanation> | undefined;
  const remember = (error: unknown, stage: string): void => {
    primary ??= Object.freeze({
      error,
      stage: boundedFailureStage(stage),
      code: boundedSuperFailureCode(error),
    });
  };
  return Object.freeze({
    agentMode: request.agentMode,
    remember,
    primaryError: () => primary?.error,
    async explain(input) {
      remember(input.error, input.input.problem.stage);
      const steeringVersion =
        input.steeringVersion ?? steering.snapshot().version;
      const problem = {
        stage: primary!.stage,
        code: primary!.code,
        ...projectOutputLimitCause(primary!.error),
      };
      if (!attempt) {
        // Install the promise before invoking model services or callbacks.
        attempt = Promise.resolve().then(() =>
          runSuperDegradedFinalization({
            request,
            input: { ...input.input, problem },
            error: primary!.error,
            maxResponseChars: input.maxResponseChars,
            steeringVersion,
            ...(params.readBudgets ? { readBudgets: params.readBudgets } : {}),
          }),
        );
      }
      const explanation = await attempt;
      if (explanation.steeringVersion !== steeringVersion)
        return createSuperFailureFallback(
          { problem, progress: null },
          steeringVersion,
        );
      return explanation;
    },
  });
}

function projectTrustedFailureRequest(
  seed: RequestExecutionSeed,
): RequestExecutionSeed {
  return Object.freeze({
    requestId: seed.requestId,
    sessionId: seed.sessionId,
    prompt: seed.prompt,
    historyMessages: [],
    shouldGenerateSessionTitle: false,
    runnerConfig: seed.runnerConfig,
    agentMode: seed.agentMode,
    modelGatewayClient: seed.modelGatewayClient,
    toolPermissionMode: seed.toolPermissionMode,
    abortSignal: seed.abortSignal,
    ...(seed.modelPreference ? { modelPreference: seed.modelPreference } : {}),
    ...(seed.modelPolicy ? { modelPolicy: seed.modelPolicy } : {}),
    ...(seed.modelInvocationScope
      ? { modelInvocationScope: seed.modelInvocationScope }
      : {}),
    ...(seed.requestSteering ? { requestSteering: seed.requestSteering } : {}),
    onAcknowledgement: () => undefined,
    onSessionTitle: async () => undefined,
    onAnswerToken: () => undefined,
    onThinkingDelta: seed.onThinkingDelta,
    onThinkingTrace: seed.onThinkingTrace,
    onEvent: seed.onEvent,
  });
}

function boundedFailureStage(stage: string): string {
  return /^[a-z][a-z0-9_.-]{0,119}$/iu.test(stage) ? stage : "request_failure";
}
