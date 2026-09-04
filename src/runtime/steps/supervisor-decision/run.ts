import {
  invokeStructuredModelStep,
  StructuredModelInvalidOutputError,
  type StructuredModelParseResult,
} from "../../model/invoke-structured-step.js";
import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import { createModelStepCompactionController } from "../../context/model-step-compaction.js";
import { createSessionMemoryAwareCompactionController } from "../../context/session-memory/index.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import {
  resolveRequestSteeringInbox,
  type RequestSteeringInbox,
} from "../../request/request-steering.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import {
  SUPERVISOR_DECISION_MODEL_STEP,
  type SupervisorDecision,
  type SupervisorDecisionCallIdentity,
  type SupervisorDecisionDiagnosticContext,
  type SupervisorDecisionOutcome,
  type SupervisorDelegateRoleId,
  type SupervisorResumeContext,
  type SupervisorRoutingDecision,
  type SupervisorWorkingDirectoryDecision,
  type SupervisorWorkingDirectoryRoutingDecision,
  type SupervisorWorkerCapabilityAffordance,
} from "./contracts.js";
import {
  traceSupervisorDecisionPhaseSuperseded,
  traceSupervisorModelCompleted,
  traceSupervisorModelFailed,
  traceSupervisorModelStarted,
  traceSupervisorWorkingDirectoryModelStarted,
} from "./diagnostics.js";
import { buildSupervisorDecisionInput } from "./input.js";
import { buildSupervisorCapabilityBriefOptions } from "./capability-brief.js";
import { parseSupervisorDecisionOutput } from "./parser.js";
import {
  buildSupervisorWorkingDirectoryInput,
  mergeSupervisorWorkingDirectory,
  parseSupervisorWorkingDirectoryOutput,
} from "./working-directory.js";
import { SUPERVISOR_RESPONSE_MODEL_STEP } from "../supervisor-response/contracts.js";
import { resolveCanonicalReviewerCompletionTargetText } from "../reviewer-decision/contracts.js";

type AcceptedSupervisorPhase<T> = Readonly<{
  decision: T;
  steeringVersion: number;
}>;

export async function runSupervisorDecision(
  request: RequestExecutionScope,
  options: Readonly<{
    call: SupervisorDecisionCallIdentity;
    toolResults: RequestToolResultsView;
    includeAcknowledgement?: boolean;
    includeTitle?: boolean;
    allowedRoleIds?: readonly SupervisorDelegateRoleId[];
    resume?: SupervisorResumeContext;
    workerCapabilityAffordances?: readonly SupervisorWorkerCapabilityAffordance[];
    availableWorkerCapabilityCatalog?: readonly WorkerCapabilityCatalogGroup[];
  }>,
): Promise<SupervisorDecisionOutcome> {
  const baseDiagnostic: SupervisorDecisionDiagnosticContext = {
    requestId: request.requestId,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    ...options.call,
  };
  const routingDiagnostic: SupervisorDecisionDiagnosticContext = Object.freeze({
    ...baseDiagnostic,
    decisionPhase: "routing",
  });
  const workingDirectoryDiagnostic: SupervisorDecisionDiagnosticContext =
    Object.freeze({
      ...baseDiagnostic,
      decisionPhase: "working_directory",
    });
  const input = buildSupervisorDecisionInput(request, {
    ...buildSupervisorCapabilityBriefOptions(request, options),
    toolResults: options.toolResults,
    ...(options.includeAcknowledgement === undefined
      ? {}
      : { includeAcknowledgement: options.includeAcknowledgement }),
    ...(options.includeTitle === undefined
      ? {}
      : { includeTitle: options.includeTitle }),
    ...(options.allowedRoleIds === undefined
      ? {}
      : { allowedRoleIds: options.allowedRoleIds }),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.workerCapabilityAffordances === undefined
      ? {}
      : {
          workerCapabilityAffordances: options.workerCapabilityAffordances,
        }),
    ...(options.availableWorkerCapabilityCatalog === undefined
      ? {}
      : {
          availableWorkerCapabilityCatalog:
            options.availableWorkerCapabilityCatalog,
        }),
    diagnostic: routingDiagnostic,
  });
  const requestSteering = resolveRequestSteeringInbox(request.requestSteering);
  const contextCompaction = createSessionMemoryAwareCompactionController(
    request,
    createModelStepCompactionController(request, {
      call: {
        roleId: "supervisor",
        callId: options.call.callId,
        objective: request.prompt,
      },
      sourceRevision: options.toolResults.sourceRevision,
      allowedConsumers: Object.freeze([
        SUPERVISOR_DECISION_MODEL_STEP,
        SUPERVISOR_RESPONSE_MODEL_STEP,
      ]),
    }),
  );

  for (;;) {
    const routing = await runRoutingPhase({
      request,
      requestSteering,
      input,
      diagnostic: routingDiagnostic,
      contextCompaction,
    });
    if (
      routing.decision.action === "invoke_role" &&
      routing.decision.roleId === "reviewer"
    ) {
      return createDecisionOutcome(
        Object.freeze({
          ...routing.decision,
          objective: resolveCanonicalReviewerCompletionTargetText(
            request.prompt,
          ),
        }),
        routing.steeringVersion,
      );
    }
    if (!requiresWorkingDirectory(routing.decision)) {
      return createDecisionOutcome(routing.decision, routing.steeringVersion);
    }

    if (!requestSteering.isCurrent(routing.steeringVersion)) {
      tracePhaseSuperseded({
        diagnostic: workingDirectoryDiagnostic,
        requestSteering,
        routingSteeringVersion: routing.steeringVersion,
        checkpoint: "before_working_directory",
      });
      continue;
    }

    const workingDirectoryInput = buildSupervisorWorkingDirectoryInput(
      input.context,
      {
        frozenDecision: routing.decision,
        diagnostic: workingDirectoryDiagnostic,
      },
    );
    const workingDirectory = await runWorkingDirectoryPhase({
      request,
      requestSteering,
      input: workingDirectoryInput,
      frozenDecision: routing.decision,
      diagnostic: workingDirectoryDiagnostic,
      contextCompaction,
    });
    const merged = mergeSupervisorWorkingDirectory(
      routing.decision,
      workingDirectory.decision,
    );

    if (
      workingDirectory.steeringVersion !== routing.steeringVersion ||
      !requestSteering.isCurrent(workingDirectory.steeringVersion)
    ) {
      tracePhaseSuperseded({
        diagnostic: workingDirectoryDiagnostic,
        requestSteering,
        routingSteeringVersion: routing.steeringVersion,
        workingDirectorySteeringVersion: workingDirectory.steeringVersion,
        checkpoint: "after_working_directory",
      });
      continue;
    }

    return createDecisionOutcome(merged, workingDirectory.steeringVersion);
  }
}

function createDecisionOutcome(
  decision: SupervisorDecision,
  steeringVersion: number,
): SupervisorDecisionOutcome {
  return Object.freeze({ decision, steeringVersion });
}

async function runRoutingPhase(params: {
  request: RequestExecutionScope;
  requestSteering: RequestSteeringInbox;
  input: ReturnType<typeof buildSupervisorDecisionInput>;
  diagnostic: SupervisorDecisionDiagnosticContext;
  contextCompaction: ModelStepContextCompactionController;
}): Promise<AcceptedSupervisorPhase<SupervisorRoutingDecision>> {
  const startedAt = Date.now();
  traceSupervisorModelStarted({
    diagnostic: params.diagnostic,
    messageCount: params.input.context.messages.length,
    messageCharacterCount: params.input.context.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    includeAcknowledgement: params.input.includeAcknowledgement,
    includeTitle: params.input.includeTitle,
    allowedRoleIds: params.input.allowedRoleIds,
    availableWorkerCapabilityCatalog:
      params.input.availableWorkerCapabilityCatalog,
  });

  try {
    const accepted = await invokeStructuredModelStep({
      request: params.request,
      modelStep: params.input.modelStep,
      format: params.input.format,
      messages: params.input.context.messages,
      contextCompaction: params.contextCompaction,
      timeoutReason: "supervisor_decision_timeout",
      invalidOutputReason: "invalid_supervisor_decision",
      parse: (text) =>
        captureAcceptedPhase(
          parseSupervisorDecisionOutput(text, {
            includeAcknowledgement: params.input.includeAcknowledgement,
            includeTitle: params.input.includeTitle,
            allowedRoleIds: params.input.allowedRoleIds,
            availableWorkerCapabilityCatalog:
              params.input.availableWorkerCapabilityCatalog,
            diagnostic: params.diagnostic,
          }),
          params.requestSteering,
        ),
    });
    traceSupervisorModelCompleted({
      diagnostic: params.diagnostic,
      decision: accepted.decision,
      durationMs: Date.now() - startedAt,
    });
    return accepted;
  } catch (error: unknown) {
    tracePhaseFailure(params.diagnostic, startedAt, error);
    throw error;
  }
}

async function runWorkingDirectoryPhase(params: {
  request: RequestExecutionScope;
  requestSteering: RequestSteeringInbox;
  input: ReturnType<typeof buildSupervisorWorkingDirectoryInput>;
  frozenDecision: SupervisorWorkingDirectoryRoutingDecision;
  diagnostic: SupervisorDecisionDiagnosticContext;
  contextCompaction: ModelStepContextCompactionController;
}): Promise<AcceptedSupervisorPhase<SupervisorWorkingDirectoryDecision>> {
  const startedAt = Date.now();
  traceSupervisorWorkingDirectoryModelStarted({
    diagnostic: params.diagnostic,
    messageCount: params.input.messages.length,
    messageCharacterCount: params.input.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ),
    frozenDecision: params.frozenDecision,
  });

  try {
    const accepted = await invokeStructuredModelStep({
      request: params.request,
      modelStep: params.input.modelStep,
      format: params.input.format,
      messages: params.input.messages,
      contextCompaction: params.contextCompaction,
      timeoutReason: "supervisor_decision_timeout",
      invalidOutputReason: "invalid_supervisor_decision",
      parse: (text) =>
        captureAcceptedPhase(
          parseSupervisorWorkingDirectoryOutput(text, {
            diagnostic: params.diagnostic,
          }),
          params.requestSteering,
        ),
    });
    traceSupervisorModelCompleted({
      diagnostic: params.diagnostic,
      decision: mergeSupervisorWorkingDirectory(
        params.frozenDecision,
        accepted.decision,
      ),
      durationMs: Date.now() - startedAt,
    });
    return accepted;
  } catch (error: unknown) {
    tracePhaseFailure(params.diagnostic, startedAt, error);
    throw error;
  }
}

function captureAcceptedPhase<T>(
  parsed: StructuredModelParseResult<T>,
  requestSteering: RequestSteeringInbox,
): StructuredModelParseResult<AcceptedSupervisorPhase<T>> {
  if (!parsed.ok) {
    return parsed;
  }
  return Object.freeze({
    ok: true as const,
    decision: Object.freeze({
      decision: parsed.decision,
      steeringVersion: requestSteering.snapshot().version,
    }),
  });
}

function requiresWorkingDirectory(
  decision: SupervisorRoutingDecision,
): decision is SupervisorWorkingDirectoryRoutingDecision {
  return (
    decision.action === "invoke_role" &&
    (decision.roleId === "planner" || decision.roleId === "worker")
  );
}

function tracePhaseFailure(
  diagnostic: SupervisorDecisionDiagnosticContext,
  startedAt: number,
  error: unknown,
): void {
  traceSupervisorModelFailed({
    diagnostic,
    durationMs: Date.now() - startedAt,
    errorType: error instanceof Error && error.name ? error.name : typeof error,
    invalidStructuredOutput: error instanceof StructuredModelInvalidOutputError,
  });
}

function tracePhaseSuperseded(params: {
  diagnostic: SupervisorDecisionDiagnosticContext;
  requestSteering: RequestSteeringInbox;
  routingSteeringVersion: number;
  workingDirectorySteeringVersion?: number;
  checkpoint: "before_working_directory" | "after_working_directory";
}): void {
  traceSupervisorDecisionPhaseSuperseded({
    diagnostic: params.diagnostic,
    routingSteeringVersion: params.routingSteeringVersion,
    currentSteeringVersion: params.requestSteering.snapshot().version,
    ...(params.workingDirectorySteeringVersion === undefined
      ? {}
      : {
          workingDirectorySteeringVersion:
            params.workingDirectorySteeringVersion,
        }),
    checkpoint: params.checkpoint,
  });
}
