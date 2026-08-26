import { projectRequestContext } from "../../context/request-context.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import {
  buildRequestSourceMessage,
  projectRequestSource,
} from "../../context/request-source.js";
import {
  invokeRepairableRawModelStep,
  type RawModelValidationResult,
} from "../../model/invoke-raw-step.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type { ModelStepOutputDiagnostics } from "../../model/invoke-step.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { classifyRuntimeErrorType } from "../../observability/error-type.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import {
  workerCapabilityContextCompactionScopeId,
  WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
} from "../../orchestration/worker-capabilities/index.js";
import {
  WORKER_RESULT_MAX_LENGTH,
  WORKER_RESULT_MODEL_STEP,
  type WorkerDecisionDiagnosticContext,
  type WorkerResultAuthorSource,
} from "./contracts.js";
import {
  buildWorkerResultInstructions,
  buildWorkerResultRepairHint,
} from "./prompt.js";

const WORKER_RESULT_MAX_REPAIR_ATTEMPTS = 1;

export async function runWorkerResultAuthor(
  request: RequestExecutionScope,
  options: Readonly<{
    diagnostic: WorkerDecisionDiagnosticContext;
    source: WorkerResultAuthorSource;
  }>,
): Promise<string> {
  const diagnostic = {
    requestId: request.requestId,
    role: "worker",
    modelStep: WORKER_RESULT_MODEL_STEP,
    sourceDecisionPhase: options.diagnostic.decisionPhase,
    callId: options.diagnostic.callId,
    parentCallId: options.diagnostic.parentCallId,
    depth: options.diagnostic.depth,
    invocationAttempt: options.diagnostic.invocationAttempt,
  };
  const startedAt = Date.now();
  let modelStarted = false;
  try {
    validateSource(options.source, options.diagnostic);
    const budget = resolveModelContextBudget({
      runnerConfig: request.runnerConfig,
      agentMode: request.agentMode,
      modelStep: WORKER_RESULT_MODEL_STEP,
      ...(request.modelPreference
        ? { modelPreference: request.modelPreference }
        : {}),
      ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
    });
    const prompt = JSON.stringify({
      kind: "runtime_worker_result_assignment",
      callId: options.source.callId,
      parentCallId: options.source.parentCallId,
      depth: options.source.depth,
      invocationAttempt: options.source.invocationAttempt,
      objective: options.source.objective,
      ...(options.source.dependencyResults.length > 0
        ? { dependencyResults: options.source.dependencyResults }
        : {}),
    });
    const requestSource = projectRequestSource({
      requestId: request.requestId,
      prompt: request.prompt,
      modelStep: WORKER_RESULT_MODEL_STEP,
      callId: options.source.callId,
    });
    const referenceMessages = Object.freeze([
      buildRequestSourceMessage(requestSource),
      ...(options.source.requestToolResultsContextMessage
        ? [options.source.requestToolResultsContextMessage]
        : []),
    ]);
    const context = projectRequestContext({
      instructions: buildWorkerResultInstructions(),
      historyMessages: [],
      prompt,
      referenceMessages,
      budget,
      diagnostic,
      onEvent: request.onEvent,
      deferCompactionFailure: true,
    });
    traceDebug("runtime.worker", "result.context.projected", {
      ...diagnostic,
      messageCount: context.messages.length,
      messageCharacterCount: context.messages.reduce(
        (total, message) => total + message.content.length,
        0,
      ),
      dependencyResultCount: options.source.dependencyResults.length,
      dependencyResultSummaryLength: options.source.dependencyResults.reduce(
        (total, result) => total + result.summary.length,
        0,
      ),
      referenceMessageCount: referenceMessages.length,
      requestToolResultCount: options.source.requestToolResults.results.length,
      requestToolResultSummaryLength:
        options.source.requestToolResults.results.reduce(
          (total, result) => total + result.summary.length,
          0,
        ),
      requestToolResultsContextLength:
        options.source.requestToolResultsContextMessage?.content.length ?? 0,
      estimatedInputTokens: context.budget.estimatedInputTokens,
      availableInputTokens: context.budget.availableInputTokens,
    });
    traceDebug("runtime.worker", "result.model.started", diagnostic);
    modelStarted = true;
    const result = await invokeRepairableRawModelStep({
      request,
      modelStep: WORKER_RESULT_MODEL_STEP,
      messages: context.messages,
      contextCompaction: createModelStepCompactionController(request, {
        call: {
          roleId: "worker",
          callId: options.source.callId,
          objective: options.source.objective,
        },
        sourceRevision: options.source.requestToolResults.sourceRevision,
        allowedConsumers:
          WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
        scopeId: workerCapabilityContextCompactionScopeId(
          options.source.callId,
        ),
      }),
      timeoutReason: "worker_result_timeout",
      maxRepairAttempts: WORKER_RESULT_MAX_REPAIR_ATTEMPTS,
      validate: validateCompleteWorkerResult,
      buildRepairHint: buildWorkerResultRepairHint,
    });
    traceDebug("runtime.worker", "result.model.completed", {
      ...diagnostic,
      durationMs: Date.now() - startedAt,
      resultLength: result.length,
      requestToolResultCount: options.source.requestToolResults.results.length,
      requestToolResultSummaryLength:
        options.source.requestToolResults.results.reduce(
          (total, toolResult) => total + toolResult.summary.length,
          0,
        ),
      referencedToolExecutionIds:
        options.source.requestToolResults.results.flatMap((toolResult) =>
          result.includes(toolResult.executionId)
            ? [toolResult.executionId]
            : [],
        ),
    });
    return result;
  } catch (error: unknown) {
    traceDebug(
      "runtime.worker",
      modelStarted ? "result.model.failed" : "result.context.rejected",
      {
        ...diagnostic,
        durationMs: Date.now() - startedAt,
        errorType: classifyRuntimeErrorType(error),
      },
    );
    throw error;
  }
}

function validateCompleteWorkerResult(
  text: string,
  _diagnostics: ModelStepOutputDiagnostics,
): RawModelValidationResult {
  const result = text.trim();
  if (!result) {
    return Object.freeze({
      ok: false,
      stage: "raw_result",
      issues: Object.freeze([
        Object.freeze({
          code: "worker_result_empty",
          path: "result",
          message: "Return one non-empty raw Worker handoff.",
        }),
      ]),
      reason: "invalid_worker_result",
    });
  }
  if (result.length > WORKER_RESULT_MAX_LENGTH) {
    return Object.freeze({
      ok: false,
      stage: "raw_result",
      issues: Object.freeze([
        Object.freeze({
          code: "worker_result_too_long",
          path: "result",
          message: `Return at most ${WORKER_RESULT_MAX_LENGTH} characters without file bodies, source code, diffs, or tool transcripts.`,
        }),
      ]),
      reason: "invalid_worker_result",
    });
  }
  return Object.freeze({ ok: true, value: result });
}

function validateSource(
  source: WorkerResultAuthorSource,
  diagnostic: WorkerDecisionDiagnosticContext,
): void {
  if (
    !Object.isFrozen(source) ||
    source.callId !== diagnostic.callId ||
    source.parentCallId !== diagnostic.parentCallId ||
    source.depth !== diagnostic.depth ||
    source.invocationAttempt !== diagnostic.invocationAttempt ||
    source.objective.trim().length === 0 ||
    !Array.isArray(source.dependencyResults) ||
    !Object.isFrozen(source.requestToolResults) ||
    !Number.isSafeInteger(source.requestToolResults.sourceRevision) ||
    source.requestToolResults.sourceRevision < 0 ||
    !Array.isArray(source.requestToolResults.results) ||
    !Object.isFrozen(source.requestToolResults.results) ||
    source.requestToolResults.results.length > 0 !==
      Boolean(source.requestToolResultsContextMessage) ||
    (source.requestToolResultsContextMessage !== undefined &&
      (!Object.isFrozen(source.requestToolResultsContextMessage) ||
        source.requestToolResultsContextMessage.role !== "user" ||
        source.requestToolResultsContextMessage.content.trim().length === 0))
  ) {
    throw new Error("worker_result_source_context_invalid");
  }
}
