import { invokeStructuredModelStep, StructuredModelInvalidOutputError, type StructuredModelParseResult } from "../../model/invoke-structured-step.js";
import { isCapabilityBriefMessage } from "../../context/capability-brief.js";
import type { ModelStepContextCompactionController, ModelStepOptionalContextProjection } from "../../model/model-step-port.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestSteeringInbox } from "../../request/request-steering.js";
import type { SupervisorDecision, SupervisorDecisionOutcome, SupervisorDecisionDiagnosticContext, SupervisorRoutingDecision, SupervisorWorkingDirectoryDecision, SupervisorWorkingDirectoryRoutingDecision } from "./contracts.js";
import { traceSupervisorDecisionPhaseSuperseded, traceSupervisorModelCompleted, traceSupervisorModelFailed, traceSupervisorModelStarted, traceSupervisorWorkingDirectoryModelStarted } from "./diagnostics.js";
import { buildSupervisorDecisionInput } from "./input.js";
import { parseSupervisorDecisionOutput } from "./parser.js";
import { parseSupervisorDelegationOutput } from "./delegation-contract.js";
import { createSupervisorArtifactPathsOptionalProjection, type SupervisorArtifactPathsProjection } from "./artifact-paths.js";
import { buildSupervisorWorkingDirectoryInput, mergeSupervisorWorkingDirectory, parseSupervisorWorkingDirectoryOutput } from "./working-directory.js";
import type { MemoryCandidate } from "../../long-term-memory/contracts.js";
import { parseSupervisorMemoryRoutingOutput } from "./memory-fusion.js";
import { deferSupervisorMemoryRouting, SupervisorMemoryRoutingBudgetFallback, type SupervisorMemoryRouting } from "./memory-routing.js";
import { parseSupervisorResumeSkillRead, SupervisorResumeSkillRoutingBudgetFallback, type SupervisorResumeSkillRead, type SupervisorResumeSkillRouting } from "./resume-skill-routing.js";

type AcceptedSupervisorPhase<T> = Readonly<{
  decision: T; steeringVersion: number; memoryCandidates?: readonly MemoryCandidate[];
}>;

export function createDecisionOutcome(
  decision: SupervisorDecision,
  steeringVersion: number,
  memoryCandidates?: readonly MemoryCandidate[],
): SupervisorDecisionOutcome {
  return Object.freeze({ decision: Object.freeze(decision), steeringVersion,
    ...(decision.action === "respond" && memoryCandidates !== undefined ? { memoryCandidates } : {}),
  });
}

export async function runRoutingPhase(params: {
  request: RequestExecutionScope;
  requestSteering: RequestSteeringInbox;
  boundSteeringVersion?: number;
  input: ReturnType<typeof buildSupervisorDecisionInput>;
  diagnostic: SupervisorDecisionDiagnosticContext;
  contextCompaction: ModelStepContextCompactionController;
  resumeSkillRouting?: SupervisorResumeSkillRouting;
  memoryRouting?: SupervisorMemoryRouting & Readonly<{
    contextCompaction: ModelStepContextCompactionController;
  }>;
}): Promise<AcceptedSupervisorPhase<SupervisorRoutingDecision | SupervisorResumeSkillRead>> {
  const startedAt = Date.now();
  let hasParsedFusedOutput = false;
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
    const accepted = await invokeStructuredModelStep<AcceptedSupervisorPhase<SupervisorRoutingDecision | SupervisorResumeSkillRead>>({
      request: params.request,
      boundSteeringVersion: params.boundSteeringVersion,
      modelStep: params.input.modelStep,
      format: params.memoryRouting?.format ?? params.input.format,
      messages: params.memoryRouting?.messages ?? params.input.context.messages,
      ...resolveSupervisorRoutingContextPolicy(params, () => hasParsedFusedOutput),
      timeoutReason: "supervisor_decision_timeout",
      invalidOutputReason: "invalid_supervisor_decision",
      parse: (text) => {
        if (params.memoryRouting || params.resumeSkillRouting) hasParsedFusedOutput = true;
        if (params.resumeSkillRouting) {
          const read = parseSupervisorResumeSkillRead(text, params.resumeSkillRouting.eligibleSkillIds);
          if (read) return captureAcceptedPhase(read, params.requestSteering);
        }
        const parseRouting = (routingText: string) => parseRoutingOutput(routingText, {
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
          });
        if (!params.memoryRouting) return captureAcceptedPhase(parseRouting(text), params.requestSteering);
        const parsed = parseSupervisorMemoryRoutingOutput(text, parseRouting, params.memoryRouting.context);
        if (!parsed.ok) return parsed;
        return { ok: true, decision: Object.freeze({
          ...parsed.decision, steeringVersion: params.requestSteering.snapshot().version,
        }) };
      },
    });
    traceSupervisorModelCompleted({
      diagnostic: params.diagnostic,
      decision: accepted.decision,
      durationMs: Date.now() - startedAt,
    });
    return accepted;
  } catch (error: unknown) {
    if (params.memoryRouting && error instanceof SupervisorMemoryRoutingBudgetFallback) {
      return runRoutingPhase({ ...params, memoryRouting: undefined });
    }
    tracePhaseFailure(params.diagnostic, startedAt, error);
    throw error;
  }
}

function resolveSupervisorRoutingContextPolicy(
  params: Pick<Parameters<typeof runRoutingPhase>[0], "request" | "input" | "memoryRouting" | "contextCompaction" | "resumeSkillRouting">,
  hasParsedFusedOutput: () => boolean,
): Readonly<{
  contextRetention?: "exact";
  optionalContextProjection?: ModelStepOptionalContextProjection;
  contextCompaction?: ModelStepContextCompactionController;
}> {
  // Defer memory first so a fitting Skill/routing decision stays combined.
  if (params.memoryRouting) return {
    contextCompaction: params.memoryRouting.contextCompaction,
    optionalContextProjection: (messages) => {
      // Preserve the repair loop; subsequent pressure uses canonical compaction.
      if (hasParsedFusedOutput()) return messages;
      return deferSupervisorMemoryRouting(params.request);
    },
  };
  if (params.resumeSkillRouting) return {
    contextCompaction: params.contextCompaction,
    optionalContextProjection: (messages) => {
      if (hasParsedFusedOutput()) return messages;
      throw new SupervisorResumeSkillRoutingBudgetFallback();
    },
  };
  if (!params.input.delegationOnly) return { contextCompaction: params.contextCompaction };
  return {
    contextRetention: "exact",
    optionalContextProjection: (messages) => {
      const projected = createSupervisorArtifactPathsOptionalProjection({
        projection: params.input.artifactPathsProjection, includeInstructions: true,
      })?.(messages) ?? messages;
      const brief = params.input.context.messages.find(isCapabilityBriefMessage);
      return brief ? projected.filter((message) => message !== brief) : projected;
    },
  };
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
            filesystemScope: params.request.workerCapabilities.filesystemScope,
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
