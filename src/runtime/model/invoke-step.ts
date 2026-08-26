import type { ChatMessage } from "../../model-gateway/types.js";
import { resolveModelInvocationStep } from "../../shared/model-step-registry.js";
import {
  assessRequestMessagesBudget,
  resolveRequestBudgetInputTokens,
} from "../context/request-context-budget.js";
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
import { countModelInputTokens } from "./input-token-count.js";
import { resolveModelContextAdmission } from "./model-context-budget.js";
import {
  resolveModelStepTimeout,
  type ResolvedModelStepTimeout,
} from "./model-step-timeout-policy.js";
import type {
  ModelStepInvocationInput,
  ModelStepOutputDiagnostics,
  RequestModelStepPort,
} from "./model-step-port.js";

export type {
  ModelStepInvocationInput,
  ModelStepOutputDiagnostics,
  RequestModelStepPort,
} from "./model-step-port.js";

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
      `${this.request.requestId}:${modelStep}:${++invocationSequence}`;
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
      const attempt = await this.beginAttempt();
      let outputDiagnostics: ModelStepOutputDiagnostics | undefined;

      try {
        const response = await attempt.invokeProvider();
        outputDiagnostics = projectOutputDiagnostics(
          response.text,
          response.meta,
        );
        attempt.recordOutputReceived(outputDiagnostics);
        if (
          this.resolveOutputDisposition(
            attempt.steeringSnapshot,
            outputDiagnostics,
          ) === "superseded"
        ) {
          continue;
        }
        const accepted = this.input.params.accept(
          response.text,
          outputDiagnostics,
        );
        this.recordCompletion(attempt.steeringSnapshot, outputDiagnostics);
        return accepted;
      } catch (error: unknown) {
        this.recordFailure(attempt, error, outputDiagnostics);
        throw error;
      } finally {
        attempt.dispose();
      }
    }
  }

  private async beginAttempt(): Promise<ModelStepAttempt> {
    const { request, params } = this.input;
    request.abortSignal.throwIfAborted();
    const steeringSnapshot = this.input.requestSteering.snapshot();
    const configuredInstructionProjection = projectConfiguredStepMessages({
      runnerConfig: request.runnerConfig,
      modelStep: params.modelStep,
      messages: params.messages,
    });
    const projectedMessages = params.contextCompaction
      ? params.contextCompaction.project(
          configuredInstructionProjection.messages,
        )
      : configuredInstructionProjection.messages;
    let messages = this.input.ownsRequestSteering
      ? appendRequestSteeringContext(projectedMessages, steeringSnapshot)
      : [...projectedMessages];
    const steeringContextIncluded =
      this.input.ownsRequestSteering && steeringSnapshot.updates.length > 0;
    const admission = resolveModelContextAdmission({
      runnerConfig: request.runnerConfig,
      agentMode: request.agentMode,
      modelStep: params.modelStep,
      ...(request.modelPreference
        ? { modelPreference: request.modelPreference }
        : {}),
      ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
      ...(params.format ? { requestFormat: params.format } : {}),
    });
    const calibrationInstructions = (admission.invocation.instructions ?? [])
      .map((instruction) => instruction.trim())
      .filter((instruction) => instruction.length > 0);
    const effectiveFormat = admission.effectiveFormat;
    const assess = async (candidateMessages: readonly ChatMessage[]) => {
      const measuredInputTokens = await countModelInputTokens({
        request,
        invocation: admission.invocation,
        modelStep: params.modelStep,
        messages: candidateMessages,
        ...(params.format !== undefined ? { format: params.format } : {}),
      });
      return assessRequestMessagesBudget({
        messages:
          calibrationInstructions.length > 0
            ? [
                {
                  role: "system" as const,
                  content: calibrationInstructions.join("\n"),
                },
                ...candidateMessages,
              ]
            : candidateMessages,
        ...(isSchemaFormat(effectiveFormat)
          ? { format: { schema: effectiveFormat.schema } }
          : {}),
        budget: admission.budget,
        ...(measuredInputTokens !== undefined ? { measuredInputTokens } : {}),
      });
    };
    let assessment = await assess(messages);
    const invocationId = this.input.nextInvocationId();
    const compactionTriggerEligible = params.modelStep !== "context.compact";
    const compactionRequired =
      compactionTriggerEligible &&
      (!assessment.fits ||
        resolveRequestBudgetInputTokens(assessment.budget) >=
          assessment.budget.compactionTriggerInputTokens);

    if (compactionRequired) {
      const before = assessment;
      const compactionScope = params.contextCompaction?.compactionScope;
      this.input.onContextEvent?.("context.compaction.started", {
        stage: "context_compaction",
        phase: "started",
        requestId: request.requestId,
        invocationId,
        modelStep: params.modelStep,
        profileId: admission.invocation.profile.id,
        reason: "context_window_threshold",
        compactionScope,
        contextWindowTokens: before.budget.contextWindowTokens,
        beforeInputTokens: resolveRequestBudgetInputTokens(before.budget),
        beforeUsedContextPercent: before.budget.usedContextPercent,
        triggerInputTokens: before.budget.compactionTriggerInputTokens,
      });
      if (!params.contextCompaction) {
        this.input.onContextEvent?.("context.compaction.failed", {
          stage: "context_compaction",
          phase: "failed",
          requestId: request.requestId,
          invocationId,
          modelStep: params.modelStep,
          profileId: admission.invocation.profile.id,
          reason: "context_compaction_controller_unavailable",
          beforeInputTokens: resolveRequestBudgetInputTokens(before.budget),
        });
        throw new Error("request_context_compaction_required");
      }
      try {
        const prepared = await params.contextCompaction.prepare(messages);
        const compactedAssessment = await assess(prepared.messages);
        if (
          !compactedAssessment.fits ||
          resolveRequestBudgetInputTokens(compactedAssessment.budget) >=
            compactedAssessment.budget.compactionTriggerInputTokens ||
          resolveRequestBudgetInputTokens(compactedAssessment.budget) >=
            resolveRequestBudgetInputTokens(before.budget)
        ) {
          throw new Error("context_compaction_projection_not_reduced");
        }
        await prepared.commit();
        messages = prepared.messages;
        assessment = compactedAssessment;
        this.input.onContextEvent?.("context.compaction.completed", {
          stage: "context_compaction",
          phase: "completed",
          requestId: request.requestId,
          invocationId,
          modelStep: params.modelStep,
          profileId: admission.invocation.profile.id,
          reason: "context_window_threshold",
          compactionScope,
          scopeId: prepared.scopeId,
          sourceRevision: prepared.sourceRevision,
          coveredSourceCount: prepared.coveredSourceCount,
          contextWindowTokens: assessment.budget.contextWindowTokens,
          beforeInputTokens: resolveRequestBudgetInputTokens(before.budget),
          beforeUsedContextPercent: before.budget.usedContextPercent,
          afterInputTokens: resolveRequestBudgetInputTokens(assessment.budget),
          afterUsedContextPercent: assessment.budget.usedContextPercent,
          triggerInputTokens: assessment.budget.compactionTriggerInputTokens,
        });
      } catch (error: unknown) {
        this.input.onContextEvent?.("context.compaction.failed", {
          stage: "context_compaction",
          phase: "failed",
          requestId: request.requestId,
          invocationId,
          modelStep: params.modelStep,
          profileId: admission.invocation.profile.id,
          reason: "semantic_checkpoint_rejected",
          compactionScope,
          beforeInputTokens: resolveRequestBudgetInputTokens(before.budget),
          issueCode: error instanceof Error ? error.message : "unknown_error",
        });
        throw error;
      }
    }
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
      compactionTriggerPercent: 70,
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
      steeringDisposition: this.input.ownsRequestSteering
        ? "supervisor_owned"
        : "deferred_to_supervisor",
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
      messages,
      steeringSnapshot,
      invocationId,
      profileId: admission.invocation.profile.id,
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
    outputDiagnostics: ModelStepOutputDiagnostics,
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
      !ownsRequestSteering &&
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
      responseReceived: outputDiagnostics !== undefined,
      steeringVersion: attempt.steeringSnapshot.version,
      supersededAttemptCount: this.supersededAttemptCount,
      ...(outputDiagnostics ?? {}),
    });
  }
}

type ModelStepAttemptConstructor<T> = Readonly<{
  request: RequestModelInvocationView;
  params: ModelStepInvocationInput<T>;
  messages: ChatMessage[];
  steeringSnapshot: RequestSteeringSnapshot;
  invocationId: string;
  profileId: string;
  stepAbort: ReturnType<typeof createModelStepAbort>;
  onThinking: (delta: string) => void;
  onContextEvent?: (name: string, extra?: Record<string, unknown>) => void;
}>;

/** Owns one provider attempt and its disposable child abort scope. */
class ModelStepAttempt {
  readonly steeringSnapshot: RequestSteeringSnapshot;

  constructor(private readonly input: ModelStepAttemptConstructor<unknown>) {
    this.steeringSnapshot = input.steeringSnapshot;
  }

  get signal(): AbortSignal {
    return this.input.stepAbort.signal;
  }

  invokeProvider() {
    const { request, params } = this.input;
    return request.modelGatewayClient.invoke({
      messages: this.input.messages,
      agentMode: request.agentMode,
      modelStep: params.modelStep,
      ...(request.modelPreference
        ? { modelPreference: request.modelPreference }
        : {}),
      ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
      abortSignal: this.input.stepAbort.signal,
      debugRequestId: request.requestId,
      ...(params.format === undefined ? {} : { format: params.format }),
      onThinking: this.input.onThinking,
    });
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
        invocationId: this.input.invocationId,
        modelStep: this.input.params.modelStep,
        profileId: this.input.profileId,
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

function isSchemaFormat(
  format: "json" | Record<string, unknown> | undefined,
): format is Record<string, unknown> & { schema: unknown } {
  return (
    typeof format === "object" &&
    format !== null &&
    Object.prototype.hasOwnProperty.call(format, "schema")
  );
}

function projectOutputDiagnostics(
  text: string,
  meta: Record<string, unknown>,
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
  if (format === undefined) {
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
