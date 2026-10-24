import { invokeStructuredModelStep, StructuredModelInvalidOutputError, type StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import type { ModelStepContextCompactionController } from "../../model/model-step-port.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestSteeringInbox } from "../../request/request-steering.js";
import type { SupervisorDecision, SupervisorDecisionOutcome, SupervisorDecisionDiagnosticContext, SupervisorRoutingDecision, SupervisorWorkingDirectoryDecision, SupervisorWorkingDirectoryRoutingDecision } from "./contracts.js";
import { traceSupervisorDecisionPhaseSuperseded, traceSupervisorModelCompleted, traceSupervisorModelFailed, traceSupervisorModelStarted, traceSupervisorWorkingDirectoryModelStarted } from "./diagnostics.js";
import { buildSupervisorDecisionInput } from "./input.js";
import { parseSupervisorDecisionOutput } from "./parser.js";
import { parseSupervisorDelegationOutput } from "./delegation-contract.js";
import { createSupervisorArtifactPathsOptionalProjection, type SupervisorArtifactPathsProjection } from "./artifact-paths.js";
import { buildSupervisorWorkingDirectoryInput, mergeSupervisorWorkingDirectory, parseSupervisorWorkingDirectoryOutput } from "./working-directory.js";

type AcceptedSupervisorPhase<T> = Readonly<{ decision: T; steeringVersion: number }>;

export function createDecisionOutcome(
  decision: SupervisorDecision,
  steeringVersion: number,
): SupervisorDecisionOutcome {
  return Object.freeze({ decision: Object.freeze(decision), steeringVersion });
}

export async function runRoutingPhase(params: {
  request: RequestExecutionScope;
  requestSteering: RequestSteeringInbox;
  boundSteeringVersion?: number;
  input: ReturnType<typeof buildSupervisorDecisionInput>;
  diagnostic: SupervisorDecisionDiagnosticContext;
  contextCompaction: ModelStepContextCompactionController;
}): Promise<AcceptedSupervisorPhase<SupervisorRoutingDecision>> {
  const startedAt = Date.now();
  traceSupervisorModelStarted({
    diagnostic: params.diagnostic,
    allowMemoryRecall: params.input.allowMemoryRecall,
    allowSkillAuthoring: params.input.allowSkillAuthoring,
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
    const parseRoutingOutput = params.input.delegationOnly
      ? parseSupervisorDelegationOutput
      : parseSupervisorDecisionOutput;
    const accepted = await invokeStructuredModelStep({
      request: params.request,
      boundSteeringVersion: params.boundSteeringVersion,
      modelStep: params.input.modelStep,
      format: params.input.format,
      messages: params.input.context.messages,
      ...(params.input.delegationOnly
        ? {
            contextRetention: "exact" as const,
            optionalContextProjection: createSupervisorArtifactPathsOptionalProjection({
              projection: params.input.artifactPathsProjection, includeInstructions: true,
            }),
          }
        : { contextCompaction: params.contextCompaction }),
      timeoutReason: "supervisor_decision_timeout",
      invalidOutputReason: "invalid_supervisor_decision",
      parse: (text) =>
        captureAcceptedPhase(
          parseRoutingOutput(text, {
            includeAcknowledgement: params.input.includeAcknowledgement,
            includeTitle: params.input.includeTitle,
            includeResponseRecommendation:
              params.input.includeResponseRecommendation,
            allowMemoryRecall: params.input.allowMemoryRecall,
            allowSkillAuthoring: params.input.allowSkillAuthoring,
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

export async function runWorkingDirectoryPhase(params: {
  request: RequestExecutionScope;
  requestSteering: RequestSteeringInbox;
  boundSteeringVersion?: number;
  input: ReturnType<typeof buildSupervisorWorkingDirectoryInput>;
  frozenDecision: SupervisorWorkingDirectoryRoutingDecision;
  diagnostic: SupervisorDecisionDiagnosticContext;
  contextCompaction: ModelStepContextCompactionController;
  exactContext?: boolean;
  artifactPathsProjection?: SupervisorArtifactPathsProjection;
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
      boundSteeringVersion: params.boundSteeringVersion,
      modelStep: params.input.modelStep,
      format: params.input.format,
      messages: params.input.messages,
      ...(params.exactContext
        ? {
            contextRetention: "exact" as const,
            optionalContextProjection: createSupervisorArtifactPathsOptionalProjection({
              projection: params.artifactPathsProjection, includeInstructions: false,
            }),
          }
        : { contextCompaction: params.contextCompaction }),
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

export function requiresWorkingDirectory(
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

export function tracePhaseSuperseded(params: {
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
