import { completeWorkerHandoffEvidence } from "./worker-handoff-compaction.js";
import { workerCompactionIntegrityInput, assertWorkerCheckpointApplicable, readWorkerCompactionCheckpoint } from "./compaction-integrity.js";
import { readSuperWorkerCompactionSidecar } from "../../context/super-worker-compaction-sidecar.js";
import { invokeStructuredModelStep, StructuredModelInvalidOutputError } from "../../model/invoke-structured-step.js";
import { buildCompactedRequestToolResultsMessage } from "../../context/request-tool-results.js";
import { createPolicyModelStepCompactionController } from "../../context/super-compaction/routing.js";
import { hasSuperContextContract } from "../../context/super-context-policy.js";
import { workerCapabilityContextCompactionScopeId, WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS } from "../../orchestration/worker-capabilities/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import { classifyRuntimeErrorType } from "../../observability/error-type.js";
import { type WorkerControlDecision, type WorkerDecisionStepResult, type WorkerDecisionDiagnosticContext, WORKER_DECISION_MODEL_STEP } from "./contracts.js";
import { traceWorkerModelCompleted, traceWorkerModelFailed, traceWorkerModelStarted } from "./diagnostics.js";
import { buildWorkerDecisionInput } from "./input.js";
import type { WorkerDecisionInputOptions } from "./input/types.js";
import { parseWorkerDecisionOutput } from "./parser.js";
import { runWorkerResultAuthor } from "./result-author.js";
import { assertWorkerEvidenceAssessmentApplicable, runWorkerEvidenceAssessment, type WorkerEvidenceAssessmentReceipt } from "./evidence-assessment.js";

type WorkerDecisionPhaseResult = Readonly<{
  decision: WorkerDecisionStepResult;
  evidenceAssessment?: WorkerEvidenceAssessmentReceipt;
}>;

export async function runWorkerDecisionPhase(
  request: RequestExecutionScope,
  options: WorkerDecisionInputOptions,
): Promise<WorkerDecisionPhaseResult> {
  let input = await prepareWorkerDecisionInput(request, options);
  const authority = options.capabilitySource?.head.policy.authority;
  const usesEvidenceStep = authority !== undefined &&
    hasSuperContextContract(authority, "delegated.worker");
  let evidenceAssessment = options.evidenceAssessment;
  if (usesEvidenceStep && !evidenceAssessment) {
    evidenceAssessment = await runWorkerEvidenceAssessment(request, {
      call: options.call,
      source: input.resultAuthorSource,
      contextMessages: input.sharedContextMessages,
      capabilitySource: options.capabilitySource,
    });
  }
  if (evidenceAssessment) {
    assertWorkerEvidenceAssessmentApplicable(evidenceAssessment, request, options);
    if (!evidenceAssessment.decision.requiresExecution) {
      const source = await completeWorkerHandoffEvidence(request, options, input);
      assertWorkerEvidenceAssessmentApplicable(evidenceAssessment, request, options);
      const result = await runWorkerResultAuthor(request, {
        diagnostic: input.diagnostic,
        source,
        evidenceAssessment,
      });
      assertWorkerEvidenceAssessmentApplicable(evidenceAssessment, request, options);
      return { decision: { action: "return_result", result }, evidenceAssessment };
    }
    options = { ...options, evidenceAssessment };
    input = await prepareWorkerDecisionInput(request, options);
  }
  const diagnostic: WorkerDecisionDiagnosticContext = input.diagnostic;
  const startedAt = Date.now();

  traceWorkerModelStarted({
    diagnostic,
    messageCount: input.context.messages.length,
    messageCharacterCount: input.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    allowedActions: input.allowedActions,
  });

  let controlDecision: WorkerControlDecision;
  try {
    controlDecision = await invokeStructuredModelStep({
      request,
      modelStep: input.modelStep,
      format: input.format,
      messages: input.context.messages,
      contextCompaction: createPolicyModelStepCompactionController(request, {
        consumer: input.modelStep,
        call: options.call,
        sourceRevision: options.requestToolResults.sourceRevision,
        superWorkerCompaction: readSuperWorkerCompactionSidecar(
          options.requestToolResults,
        ),
        requireSuperWorkerSources:
          workerCompactionIntegrityInput(request, options.capabilitySource) !==
          undefined,
        allowedConsumers:
          WORKER_CAPABILITY_CONTEXT_COMPACTION_ALLOWED_CONSUMERS,
        scopeId: workerCapabilityContextCompactionScopeId(options.call.callId),
      }, request.executionPolicy.authority),
      timeoutReason: "worker_decision_timeout",
      invalidOutputReason: "invalid_worker_decision",
      parse: (text) => {
        const parsed = parseWorkerDecisionOutput(text, diagnostic, {
          availableCapabilities: input.availableCapabilities,
          maxBatchCapabilityExecutions: input.maxBatchCapabilityExecutions,
          decisionPhase: diagnostic.decisionPhase,
          allowedActions: input.allowedActions,
          ...(input.pendingCapabilitySelection
            ? {
                pendingCapabilitySelection: input.pendingCapabilitySelection,
              }
            : {}),
          ...(input.pendingCapabilityBatchSelection
            ? {
                pendingCapabilityBatchSelection:
                  input.pendingCapabilityBatchSelection,
              }
            : {}),
        });
        return parsed;
      },
    });
    traceWorkerModelCompleted({
      diagnostic,
      decision: controlDecision,
      durationMs: Date.now() - startedAt,
    });
  } catch (error: unknown) {
    traceWorkerModelFailed({
      diagnostic,
      durationMs: Date.now() - startedAt,
      errorType: classifyRuntimeErrorType(error),
      invalidStructuredOutput:
        error instanceof StructuredModelInvalidOutputError,
    });
    throw error;
  }
  if (evidenceAssessment) {
    assertWorkerEvidenceAssessmentApplicable(evidenceAssessment, request, options);
  }
  if (controlDecision.action !== "return_result") {
    return { decision: controlDecision, ...(evidenceAssessment ? { evidenceAssessment } : {}) };
  }
  const resultAuthorSource = await completeWorkerHandoffEvidence(
    request,
    options,
    input,
  );
  const result = await runWorkerResultAuthor(request, {
    diagnostic,
    source: resultAuthorSource,
  });
  return Object.freeze({ decision: { action: "return_result" as const, result } });
}

async function prepareWorkerDecisionInput(
  request: RequestExecutionScope,
  options: Parameters<typeof buildWorkerDecisionInput>[1],
): Promise<ReturnType<typeof buildWorkerDecisionInput>> {
  const store = request.contextCompactionStore;
  const scopeId = workerCapabilityContextCompactionScopeId(options.call.callId);
  const previous = store
    ? readWorkerCompactionCheckpoint(
        store,
        options.requestToolResults,
        scopeId,
        WORKER_DECISION_MODEL_STEP,
      )
    : undefined;
  if (previous) {
    assertWorkerCheckpointApplicable(request, options.call, previous);
  }
  return buildWorkerDecisionInput(request, {
    ...options,
    ...(previous
      ? {
          requestToolResultsContextMessage:
            buildCompactedRequestToolResultsMessage(
              options.requestToolResults,
              previous,
              workerCompactionIntegrityInput(request, options.capabilitySource),
            ),
        }
      : {}),
  });
}
