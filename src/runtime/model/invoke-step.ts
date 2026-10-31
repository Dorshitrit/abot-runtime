import {
  resolveInvocationSteeringContext,
  modelStepSteeringDisposition,
  isUnboundSteeringDeferred,
} from "./model-step-steering-context.js";
import { resolveContextCompactionTriggerRatio } from "../context/request-context-budget.js";
import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocationStep } from "../../shared/model-step-registry.js";
import { projectConfiguredStepMessages } from "../config/runner/step-instructions.js";
import { traceDebug } from "../observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../observability/error-type.js";
import {
  type BoundRequestModelInvocationContext,
  type RequestModelInvocationView,
} from "../request/contracts.js";
import {
  resolveRequestSteeringInbox,
  type RequestSteeringInbox,
  type RequestSteeringSnapshot,
} from "../request/request-steering.js";
import { appendRequestSteeringContext } from "../request/request-steering-context.js";
import { createModelStepAbort } from "../steps/model-step-timeout.js";
import { acceptModelStepOutput } from "./model-step-acceptance.js";
import {
  MODEL_STEP_TIMED_OUT_EVENT,
  projectModelStepTimeoutEvent,
  type ModelStepTimeoutIdentity,
} from "./model-step-timeout-event.js";
import { projectPromptCacheBoundary } from "./prompt-cache-boundary.js";
import { createModelContextAssessment } from "./model-context-assessment.js";
import { admitOptionalModelContext } from "./optional-context-admission.js";
import {
  invokeModelProvider,
  projectModelProviderFailureDiagnostics,
} from "./provider-failure.js";
import {
  isModelStepCompactionEligible,
  resolveModelContextAdmission,
} from "./model-context-budget.js";
import {
  resolveModelStepTimeout,
  type ResolvedModelStepTimeout,
} from "./model-step-timeout-policy.js";
import type {
  ModelStepInvocationInput,
  ModelStepOutputDiagnostics,
  RequestModelStepPort,
} from "./model-step-port.js";
import {
  assertBoundModelStepSteeringCurrent,
  isModelStepSteeringSuperseded,
  assertModelStepAdmissionCurrent,
  ModelStepAdmissionSuperseded,
} from "./model-step-steering.js";

export type {
  ModelStepInvocationInput,
  ModelStepOutputDiagnostics,
  RequestModelStepPort,
} from "./model-step-port.js";

import { createModelInvocationIdentity } from "./invocation-identity.js";
import {
  admitCompactedContext,
  requiresContextCompaction,
} from "./context-compaction-admission.js";

/** Binds the immutable request services used by every model step in a request. */
export class RequestModelStepInvoker implements RequestModelStepPort {
  private readonly nextInvocationId: (modelStep: string) => string;

  constructor(
    private readonly request: RequestModelInvocationView,
    private readonly onContextEvent?: (
      name: string,
      extra?: Record<string, unknown>,
    ) => void,
  ) {
    let invocationSequence = 0;
    this.nextInvocationId = (modelStep) =>
      createModelInvocationIdentity(
        this.request.requestId,
        this.request.modelInvocationScope,
        modelStep,
        ++invocationSequence,
      );
  }

  invoke<T>(params: ModelStepInvocationInput<T>): Promise<T> {
    const config = this.request.runnerConfig.steps[params.modelStep];
    if (!config) {
      throw new Error(`Missing runtime step config: ${params.modelStep}`);
    }
    const timeout = resolveModelStepTimeout({
      modelStep: params.modelStep,
      fallbackTimeoutMs: config.timeoutMs,
      ...(this.request.modelPreference
        ? { modelPreference: this.request.modelPreference }
        : {}),
      ...(this.request.modelPolicy
        ? { modelPolicy: this.request.modelPolicy }
        : {}),
    });
    const formatDiagnostics = projectFormatDiagnostics(params.format);
    const requestSteering = resolveRequestSteeringInbox(
      this.request.requestSteering,
    );
    const ownsRequestSteering =
      resolveModelInvocationStep(params.modelStep)?.role === "supervisor";

    return new ModelStepInvocation({
      request: this.request,
      params,
      configuredTimeoutMs: config.timeoutMs,
      timeout,
      formatDiagnostics,
      requestSteering,
      ownsRequestSteering,
      nextInvocationId: () => this.nextInvocationId(params.modelStep),
      ...(this.onContextEvent ? { onContextEvent: this.onContextEvent } : {}),
    }).run();
  }
}

/** Reuses the single canonical request-owned model-step port. */
export function resolveRequestModelStepInvoker(
  request: BoundRequestModelInvocationContext,
): RequestModelStepPort {
  return request.modelSteps;
}

export async function invokeModelStep<T>(
  params: ModelStepInvocationInput<T> &
    Readonly<{ request: BoundRequestModelInvocationContext }>,
): Promise<T> {
  return resolveRequestModelStepInvoker(params.request).invoke(params);
}

type ModelStepInvocationConstructor<T> = Readonly<{
  request: RequestModelInvocationView;
  params: ModelStepInvocationInput<T>;
  configuredTimeoutMs: number;
  timeout: ResolvedModelStepTimeout;
  formatDiagnostics: Record<string, unknown>;
  requestSteering: RequestSteeringInbox;
  ownsRequestSteering: boolean;
  nextInvocationId: () => string;
  onContextEvent?: (name: string, extra?: Record<string, unknown>) => void;
}>;

/** Owns one logical step across any supervisor steering supersession retries. */
class ModelStepInvocation<T> {
  private thinkingText = "";
  private supersededAttemptCount = 0;

  constructor(private readonly input: ModelStepInvocationConstructor<T>) {}

  async run(): Promise<T> {
    for (;;) {
      this.input.request.abortSignal.throwIfAborted();
      assertBoundModelStepSteeringCurrent(
        this.input.requestSteering,
        this.input.params.boundSteeringVersion,
      );
      const beginning = await this.beginAttempt();
      if (beginning.kind === "superseded") {
        this.resolveOutputDisposition(beginning.steeringSnapshot);
        continue;
      }
      const attempt = beginning.attempt;
      let outputDiagnostics: ModelStepOutputDiagnostics | undefined;

      try {
        assertModelStepAdmissionCurrent({
          abortSignal: this.input.request.abortSignal,
          requestSteering: this.input.requestSteering,
          boundSteeringVersion: this.input.params.boundSteeringVersion,
          ownsRequestSteering: this.input.ownsRequestSteering,
          steeringSnapshot: attempt.steeringSnapshot,
        });
        const response = await attempt.invokeProvider();
        this.input.request.abortSignal.throwIfAborted();
        attempt.signal.throwIfAborted();
        outputDiagnostics = projectOutputDiagnostics(
          response.text,
          response.meta,
          attempt.steeringSnapshot.version,
        );
        attempt.recordOutputReceived(outputDiagnostics);
        assertBoundModelStepSteeringCurrent(
          this.input.requestSteering,
          this.input.params.boundSteeringVersion,
        );
        if (
          this.resolveOutputDisposition(
            attempt.steeringSnapshot,
            outputDiagnostics,
          ) === "superseded"
        ) {
          continue;
        }
        const acceptedDiagnostics = outputDiagnostics;
        const accepted = await acceptModelStepOutput(
          () =>
            this.input.params.accept(
              response.text,
              acceptedDiagnostics,
              attempt.signal,
            ),
          attempt.signal,
        );
        this.input.request.abortSignal.throwIfAborted();
        attempt.signal.throwIfAborted();
        assertBoundModelStepSteeringCurrent(
          this.input.requestSteering,
          this.input.params.boundSteeringVersion,
        );
        if (
          this.resolveOutputDisposition(
            attempt.steeringSnapshot,
            outputDiagnostics,
          ) === "superseded"
        )
          continue;
        this.recordCompletion(attempt.steeringSnapshot, outputDiagnostics);
        return accepted;
      } catch (error: unknown) {
        if (error instanceof ModelStepAdmissionSuperseded) {
          this.input.request.abortSignal.throwIfAborted();
          attempt.signal.throwIfAborted();
          this.resolveOutputDisposition(error.steeringSnapshot);
          continue;
        }
        if (isModelStepSteeringSuperseded(error)) throw error;
        this.recordFailure(attempt, error, outputDiagnostics);
        this.input.request.abortSignal.throwIfAborted();
        attempt.signal.throwIfAborted();
        throw error;
      } finally {
        attempt.dispose();
      }
    }
  }

  private async beginAttempt(): Promise<
    | Readonly<{ kind: "ready"; attempt: ModelStepAttempt }>
    | Readonly<{
        kind: "superseded";
        steeringSnapshot: RequestSteeringSnapshot;
      }>
  > {
    try {
      return { kind: "ready", attempt: await this.prepareAttempt() };
    } catch (error: unknown) {
      this.input.request.abortSignal.throwIfAborted();
      if (error instanceof ModelStepAdmissionSuperseded) {
        return { kind: "superseded", steeringSnapshot: error.steeringSnapshot };
      }
      throw error;
    }
  }

  private async prepareAttempt(): Promise<ModelStepAttempt> {
    const { request, params } = this.input;
    request.abortSignal.throwIfAborted();
    const steeringSnapshot = this.input.requestSteering.snapshot();
    const assertNotAborted = () => request.abortSignal.throwIfAborted();
    const assertCurrent = () =>
      assertModelStepAdmissionCurrent({
        abortSignal: request.abortSignal,
        requestSteering: this.input.requestSteering,
        boundSteeringVersion: params.boundSteeringVersion,
        ownsRequestSteering: this.input.ownsRequestSteering,
        steeringSnapshot,
      });
    assertCurrent();
    const configuredInstructionProjection = projectConfiguredStepMessages({
      runnerConfig: request.runnerConfig,
      modelStep: params.modelStep,
      messages: params.messages,
      configuredInstructionPolicy: params.configuredInstructionPolicy,
    });
    const compactionTriggerEligible = isModelStepCompactionEligible(params);
    const contextCompaction = compactionTriggerEligible
      ? params.contextCompaction
      : undefined;
    const projectedMessages = contextCompaction
      ? contextCompaction.project(configuredInstructionProjection.messages)
      : configuredInstructionProjection.messages;
    const steeringContext = resolveInvocationSteeringContext(
      params, this.input.ownsRequestSteering, steeringSnapshot,
    );
    let messages = steeringContext
      ? appendRequestSteeringContext(projectedMessages, steeringContext)
      : [...projectedMessages];
    const steeringContextIncluded = (steeringContext?.updates.length ?? 0) > 0;
    const admission = resolveModelContextAdmission({
      runnerConfig: request.runnerConfig,
      agentMode: request.agentMode,
      modelStep: params.modelStep,
      ...(request.reasoningPreference ? { reasoningPreference: request.reasoningPreference } : {}),
      ...(request.modelPreference
        ? { modelPreference: request.modelPreference }
        : {}),
      ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
      ...(params.format ? { requestFormat: params.format } : {}),
    });
    const { assess, projectMedia } = createModelContextAssessment({
      request,
      params,
      admission,
      assertCurrent: assertNotAborted,
    });
    assertCurrent();
    let assessment = await assess(messages);
    assertCurrent();
    if (params.optionalContextProjection) {
      const optional = await admitOptionalModelContext({
        messages, assessment, project: params.optionalContextProjection, assess, assertCurrent,
        diagnostic: { requestId: request.requestId, modelStep: params.modelStep },
      });
      messages = [...optional.messages];
      assessment = optional.assessment;
    }
    const invocationId = this.input.nextInvocationId();
    if (requiresContextCompaction(compactionTriggerEligible, assessment)) {
      const admitted = await admitCompactedContext({
        messages,
        assessment,
        controller: contextCompaction,
        assess,
        assertCurrent,
        assertNotAborted,
        abortSignal: request.abortSignal,
        identity: {
          requestId: request.requestId,
          invocationId,
          modelStep: params.modelStep,
          profileId: admission.invocation.profile.id,
          provider: admission.invocation.profile.provider,
          model: admission.invocation.model,
          ...(request.modelInvocationScope
            ? { modelInvocationScope: request.modelInvocationScope }
            : {}),
        },
        ...(this.input.onContextEvent
          ? { onEvent: this.input.onContextEvent }
          : {}),
      });
      messages = [...admitted.messages];
      assessment = admitted.assessment;
    }
    assertCurrent();
    traceDebug("runtime.context", "budget.assessed", {
      requestId: request.requestId,
      modelStep: params.modelStep,
      phase: "pre_provider",
      outcome: assessment.fits ? "accepted" : "rejected",
      fits: assessment.fits,
      issueCode: assessment.fits ? "" : "pinned_content_exceeds_budget",
      steeringVersion: steeringSnapshot.version,
      steeringUpdateCount: steeringSnapshot.updates.length,
      steeringContextIncluded,
      messageCount: messages.length,
      measurement:
        assessment.budget.measuredInputTokens !== undefined
          ? "actual"
          : "estimated",
      source:
        assessment.budget.measuredInputTokens !== undefined
          ? "provider_input_token_count"
          : "runtime_token_estimator",
      ...assessment.budget,
    });
    this.input.onContextEvent?.("context.window.snapshot", {
      stage: "context_window",
      phase: "pre_provider",
      requestId: request.requestId,
      invocationId,
      modelStep: params.modelStep,
      profileId: admission.invocation.profile.id,
      provider: admission.invocation.profile.provider,
      model: admission.invocation.model,
      measurement:
        assessment.budget.measuredInputTokens !== undefined
          ? "actual"
          : "estimated",
      source:
        assessment.budget.measuredInputTokens !== undefined
          ? "provider_input_token_count"
          : "runtime_token_estimator",
      admissionOutcome: assessment.fits ? "accepted" : "rejected",
      compactionTriggerPercent: resolveContextCompactionTriggerRatio(admission.budget) * 100,
      compactionTriggerEligible,
      compactionRequired: false,
      remainingContextPercent: Math.max(
        0,
        Math.round((100 - assessment.budget.usedContextPercent) * 10) / 10,
      ),
      ...assessment.budget,
    });
    if (!assessment.fits) {
      throw new Error("request_context_final_envelope_exceeds_window");
    }

    const stepAbort = createModelStepAbort({
      parentSignal: request.abortSignal,
      modelStep: params.modelStep,
      timeoutMs: this.input.timeout.timeoutMs,
      timeoutReason: params.timeoutReason,
    });
    traceDebug("runtime.model", "step.started", {
      requestId: request.requestId,
      modelStep: params.modelStep,
      timeoutMs: this.input.timeout.timeoutMs,
      configuredTimeoutMs: this.input.configuredTimeoutMs,
      timeoutSource: this.input.timeout.source,
      selectedProfileId: this.input.timeout.selectedProfileId ?? "",
      calibrationSlotId: this.input.timeout.calibrationSlotId ?? "",
      steeringVersion: steeringSnapshot.version,
      steeringUpdateCount: steeringSnapshot.updates.length,
      steeringContextIncluded,
      steeringDisposition: modelStepSteeringDisposition(
        params, this.input.ownsRequestSteering,
      ),
      configuredInstructionBlockCount:
        configuredInstructionProjection.blockCount,
      configuredInstructionCharacterCount:
        configuredInstructionProjection.characterCount,
      supersededAttemptCount: this.supersededAttemptCount,
      ...this.input.formatDiagnostics,
    });

    return new ModelStepAttempt({
      request,
      params,
      messages: projectMedia(messages),
      steeringSnapshot,
      identity: {
        invocationId,
        profileId: admission.invocation.profile.id,
        provider: admission.invocation.profile.provider,
        model: admission.invocation.model,
      },
      stepAbort,
      ...(this.input.onContextEvent
        ? { onContextEvent: this.input.onContextEvent }
        : {}),
      onThinking: (delta) => this.recordThinkingDelta(delta),
    });
  }

  private recordThinkingDelta(delta: string): void {
    this.thinkingText += delta;
    this.input.request.onThinkingDelta(delta);
  }

  private resolveOutputDisposition(
    steeringSnapshot: RequestSteeringSnapshot,
    outputDiagnostics?: ModelStepOutputDiagnostics,
  ): "accepted" | "superseded" {
    const { request, params, requestSteering, ownsRequestSteering } =
      this.input;
    if (
      ownsRequestSteering &&
      !requestSteering.isCurrent(steeringSnapshot.version)
    ) {
      const current = requestSteering.snapshot();
      this.supersededAttemptCount += 1;
      traceDebug("runtime.model", "step.output_superseded", {
        requestId: request.requestId,
        modelStep: params.modelStep,
        attemptedSteeringVersion: steeringSnapshot.version,
        currentSteeringVersion: current.version,
        steeringUpdateCount: current.updates.length,
        supersededAttemptCount: this.supersededAttemptCount,
        ...outputDiagnostics,
      });
      return "superseded";
    }
    if (
      isUnboundSteeringDeferred(
        ownsRequestSteering, params.boundSteeringVersion,
      ) &&
      !requestSteering.isCurrent(steeringSnapshot.version)
    ) {
      const current = requestSteering.snapshot();
      traceDebug("runtime.model", "step.output_steering_deferred", {
        requestId: request.requestId,
        modelStep: params.modelStep,
        attemptedSteeringVersion: steeringSnapshot.version,
        currentSteeringVersion: current.version,
        steeringUpdateCount: current.updates.length,
        ...outputDiagnostics,
      });
    }
    return "accepted";
  }

  private recordCompletion(
    steeringSnapshot: RequestSteeringSnapshot,
    outputDiagnostics: ModelStepOutputDiagnostics,
  ): void {
    const { request, params } = this.input;
    request.onThinkingTrace({
      step: params.modelStep,
      status: "completed",
      text: this.thinkingText,
    });
    traceDebug("runtime.model", "step.completed", {
      requestId: request.requestId,
      modelStep: params.modelStep,
      steeringVersion: steeringSnapshot.version,
      supersededAttemptCount: this.supersededAttemptCount,
      ...outputDiagnostics,
    });
  }

  private recordFailure(
    attempt: ModelStepAttempt,
    error: unknown,
    outputDiagnostics: ModelStepOutputDiagnostics | undefined,
  ): void {
    const { request, params } = this.input;
    const status = request.abortSignal.aborted
      ? "aborted"
      : attempt.signal.aborted
        ? "timeout"
        : "error";
    request.onThinkingTrace({
      step: params.modelStep,
      status,
      text: this.thinkingText,
    });
    traceDebug("runtime.model", "step.failed", {
      requestId: request.requestId,
      modelStep: params.modelStep,
      status,
      errorType: classifyRuntimeErrorType(error),
      ...projectModelProviderFailureDiagnostics(error, params.messages),
      responseReceived: outputDiagnostics !== undefined,
      steeringVersion: attempt.steeringSnapshot.version,
      supersededAttemptCount: this.supersededAttemptCount,
      ...(outputDiagnostics ?? {}),
    });
    const timeoutEvent = projectModelStepTimeoutEvent({
      requestId: request.requestId,
      modelStep: params.modelStep,
      identity: attempt.identity,
      parentSignal: request.abortSignal,
      attemptSignal: attempt.signal,
      configuredTimeoutMs: this.input.configuredTimeoutMs,
      timeout: this.input.timeout,
      ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
    });
    if (timeoutEvent) this.input.onContextEvent?.(MODEL_STEP_TIMED_OUT_EVENT, timeoutEvent);
  }
}

type ModelStepAttemptConstructor<T> = Readonly<{
  request: RequestModelInvocationView;
  params: ModelStepInvocationInput<T>;
  messages: ChatMessage[];
  steeringSnapshot: RequestSteeringSnapshot;
  identity: ModelStepTimeoutIdentity;
  stepAbort: ReturnType<typeof createModelStepAbort>;
  onThinking: (delta: string) => void;
  onContextEvent?: (name: string, extra?: Record<string, unknown>) => void;
}>;

/** Owns one provider attempt and its disposable child abort scope. */
class ModelStepAttempt {
  readonly steeringSnapshot: RequestSteeringSnapshot;
  readonly identity: ModelStepTimeoutIdentity;

  constructor(private readonly input: ModelStepAttemptConstructor<unknown>) {
    this.steeringSnapshot = input.steeringSnapshot;
    this.identity = input.identity;
  }

  get signal(): AbortSignal {
    return this.input.stepAbort.signal;
  }

  invokeProvider() {
    const { request, params } = this.input;
    return invokeModelProvider(params.modelStep, () =>
      request.modelGatewayClient.invoke({
        messages: this.input.messages,
        ...projectPromptCacheBoundary({ messages: this.input.messages, beforeMessage: params.promptCacheBoundaryBeforeMessage }),
        agentMode: request.agentMode,
        modelStep: params.modelStep,
        ...(request.reasoningPreference ? { reasoningPreference: request.reasoningPreference } : {}),
      ...(request.modelPreference
          ? { modelPreference: request.modelPreference }
          : {}),
        ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
        abortSignal: this.input.stepAbort.signal,
        debugRequestId: request.requestId,
        ...(params.format === undefined ? {} : { format: params.format }),
        onThinking: this.input.onThinking,
      }),
    );
  }

  recordOutputReceived(outputDiagnostics: ModelStepOutputDiagnostics): void {
    traceDebug("runtime.model", "step.output_received", {
      requestId: this.input.request.requestId,
      modelStep: this.input.params.modelStep,
      steeringVersion: this.steeringSnapshot.version,
      ...outputDiagnostics,
    });
    if (
      outputDiagnostics.providerInputTokens !== undefined ||
      outputDiagnostics.providerOutputTokens !== undefined ||
      outputDiagnostics.providerTotalTokens !== undefined
    ) {
      this.input.onContextEvent?.("context.window.provider_usage", {
        stage: "context_window",
        phase: "provider_completed",
        requestId: this.input.request.requestId,
        invocationId: this.identity.invocationId,
        modelStep: this.input.params.modelStep,
        profileId: this.identity.profileId,
        measurement: "actual",
        source: "provider_reported",
        ...(outputDiagnostics.providerInputTokens !== undefined
          ? { inputTokens: outputDiagnostics.providerInputTokens }
          : {}),
        ...(outputDiagnostics.providerOutputTokens !== undefined
          ? { outputTokens: outputDiagnostics.providerOutputTokens }
          : {}),
        ...(outputDiagnostics.providerTotalTokens !== undefined
          ? { totalTokens: outputDiagnostics.providerTotalTokens }
          : {}),
      });
    }
  }

  dispose(): void {
    this.input.stepAbort.dispose();
  }
}

function projectOutputDiagnostics(
  text: string,
  meta: Record<string, unknown>,
  steeringVersion: number,
): ModelStepOutputDiagnostics {
  const usage =
    meta.usage && typeof meta.usage === "object" && !Array.isArray(meta.usage)
      ? (meta.usage as Record<string, unknown>)
      : {};
  const transportOutputLength = readNonNegativeInteger(meta.outputLength);
  const terminalEventCount = readNonNegativeInteger(meta.terminalEventCount);
  const providerInputTokens = readNonNegativeInteger(usage.inputTokens);
  const providerOutputTokens = readNonNegativeInteger(usage.outputTokens);
  const providerTotalTokens = readNonNegativeInteger(usage.totalTokens);
  const hasCompletionReason = Object.prototype.hasOwnProperty.call(
    meta,
    "providerCompletionReason",
  );
  const completionReason = meta.providerCompletionReason;

  return Object.freeze({
    outputLength: text.length,
    steeringVersion,
    ...(transportOutputLength !== undefined ? { transportOutputLength } : {}),
    ...(terminalEventCount !== undefined ? { terminalEventCount } : {}),
    ...(hasCompletionReason &&
    (completionReason === null || typeof completionReason === "string")
      ? {
          providerCompletionReason:
            typeof completionReason === "string"
              ? completionReason.slice(0, 160)
              : null,
        }
      : {}),
    ...(providerInputTokens !== undefined ? { providerInputTokens } : {}),
    ...(providerOutputTokens !== undefined ? { providerOutputTokens } : {}),
    ...(providerTotalTokens !== undefined ? { providerTotalTokens } : {}),
  });
}

function projectFormatDiagnostics(
  format: "json" | Record<string, unknown> | undefined,
): Record<string, unknown> {
  const requestsPlainText = format === undefined || (typeof format === "object" && format.type === "text");
  if (requestsPlainText) {
    return {
      outputContract: "text",
      schemaCharacterCount: 0,
      schemaRootType: "",
      schemaRootPropertyCount: 0,
      schemaRootOneOfVariantCount: 0,
    };
  }
  if (format === "json") {
    return {
      outputContract: "json",
      schemaCharacterCount: 0,
      schemaRootType: "",
      schemaRootPropertyCount: 0,
      schemaRootOneOfVariantCount: 0,
    };
  }
  const schema =
    format.type === "json_schema" &&
    format.schema &&
    typeof format.schema === "object" &&
    !Array.isArray(format.schema)
      ? (format.schema as Record<string, unknown>)
      : format;
  const properties = schema.properties;
  return {
    outputContract: format.type === "json_schema" ? "json_schema" : "schema",
    schemaCharacterCount: safeJsonLength(schema),
    schemaRootType:
      typeof schema.type === "string" ? schema.type.slice(0, 64) : "",
    schemaRootPropertyCount:
      properties && typeof properties === "object" && !Array.isArray(properties)
        ? Object.keys(properties).length
        : 0,
    schemaRootOneOfVariantCount: Array.isArray(schema.oneOf)
      ? schema.oneOf.length
      : 0,
  };
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}
