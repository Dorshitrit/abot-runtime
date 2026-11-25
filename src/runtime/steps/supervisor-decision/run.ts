import { createSupervisorToolEvidence } from "../../context/supervisor-tool-evidence.js";
import { resolveMemoryRecallSteeringVersion } from "../../long-term-memory/recall-binding.js";
import type { RequestToolResultsView } from "../../context/request-tool-results.js";
import { createPolicyModelStepCompactionController } from "../../context/super-compaction/routing.js";
import { superCompactionFailureOwner } from "../../context/super-compaction-failure-owner.js";
import { createSessionMemoryAwareCompactionController } from "../../context/session-memory/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import {
  resolveRequestSteeringInbox,
} from "../../request/request-steering.js";
import type { WorkerCapabilityCatalogGroup } from "../../orchestration/worker-capabilities/index.js";
import {
  SUPERVISOR_DECISION_MODEL_STEP,
  type SupervisorDecisionCallIdentity,
  type SupervisorDecisionDiagnosticContext,
  type SupervisorDecisionOutcome,
  type SupervisorDelegateRoleId,
  type SupervisorResumeContext,
  type SupervisorWorkerCapabilityAffordance,
} from "./contracts.js";
import { buildSupervisorDecisionInput } from "./input.js";
import { buildSupervisorCapabilityBriefOptions } from "./capability-brief.js";
import { createSupervisorCapabilityBriefReadmissionController } from "./capability-brief-readmission.js";
import { createSupervisorArtifactPathsReadmissionController } from "./artifact-paths.js";
import {
  buildSupervisorWorkingDirectoryInput,
  mergeSupervisorWorkingDirectory,
} from "./working-directory.js";
import { SUPERVISOR_RESPONSE_MODEL_STEP } from "../supervisor-response/contracts.js";
import { resolveCanonicalReviewerCompletionTargetText } from "../reviewer-decision/contracts.js";
import type { ChatMessage, ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";

import { createDecisionOutcome, runRoutingPhase, runWorkingDirectoryPhase, requiresWorkingDirectory, tracePhaseSuperseded } from "./decision-phases.js";
import { isExhaustedDuplicateSkillSelection, prepareSupervisorDecision } from "./preparation.js";
import { isSupervisorSkillLookup } from "./skill-selection.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { canOfferSupervisorSkillAuthoring } from "../supervisor-skill-authoring/input.js";
import { runSupervisorSkillAuthoring } from "../supervisor-skill-authoring/run.js";
import { canRecallSupervisorMemory, projectSupervisorProcedureEntry } from "./procedure-entry.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { runFusedSupervisorEntry } from "./fused-entry.js";
import { prepareSupervisorMemoryRouting } from "./memory-routing.js";
import { preserveSupervisorMemoryRoutingContext } from "./memory-compaction.js";
import { canAdmitSupervisorResumeSkillRouting, extendSupervisorResumeSkillRoutingInput, prepareSupervisorResumeSkillRouting, SupervisorResumeSkillRoutingBudgetFallback } from "./resume-skill-routing.js";

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
    availableSkillWriteOperationIds?: readonly string[];
    memoryRecallMessage?: ChatMessage;
    initialMemoryMessage?: ChatMessage;
    memoryRecallCount?: number;
    remainingCapabilityExecutions?: number;
    remainingRoleCalls?: number;
    allowSkillReads?: boolean;
    skillReadHead?: RoleCallLedgerHead;
  }>,
): Promise<SupervisorDecisionOutcome> {
  const recallSteeringVersion = resolveMemoryRecallSteeringVersion(
    options.memoryRecallMessage,
    request.requestId,
    options.call.callId,
  );
  const baseDiagnostic: SupervisorDecisionDiagnosticContext = {
    requestId: request.requestId,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    ...options.call,
  };
  const requestSteering = resolveRequestSteeringInbox(request.requestSteering);
  const entrySteeringVersion = requestSteering.snapshot().version;
  const procedureState = projectSupervisorProcedureEntry(options, entrySteeringVersion);
  const procedureEntry = procedureState.classifyProcedure;
  const boundSteeringVersion = recallSteeringVersion;
  traceDebug("runtime.supervisor", "procedure.entry.projected", {
    ...baseDiagnostic, classifyProcedure: procedureEntry,
    allowInitialMemoryRecall: procedureState.allowInitialMemoryRecall,
    hasRecallReceipt: procedureState.memoryRecallMessage !== undefined,
    steeringVersion: entrySteeringVersion,
  });
  const routingDiagnostic: SupervisorDecisionDiagnosticContext = Object.freeze({
    ...baseDiagnostic,
    decisionPhase: "routing",
  });
  const workingDirectoryDiagnostic: SupervisorDecisionDiagnosticContext =
    Object.freeze({
      ...baseDiagnostic,
      decisionPhase: "working_directory",
    });
  const memoryRecallMessage = request.longTermMemory?.enabled
    ? procedureState.memoryRecallMessage
    : undefined;
  const initialMemoryMessage = request.longTermMemory?.enabled
    ? options.initialMemoryMessage
    : undefined;
  const skillSelectionWindow = request.supervisorSkillSelectionWindows.bind({
    rootCallId: options.call.rootCallId,
    ...(options.resume ? { returnedResultRef: options.resume.returnedResultRef } : {}),
  });
  if (procedureEntry) {
    return runFusedSupervisorEntry(request, {
      ...options, diagnostic: baseDiagnostic, skillSelectionWindow, procedureState,
      boundSteeringVersion: entrySteeringVersion, memoryRecallMessage, initialMemoryMessage,
    });
  }
  const supervisorToolEvidence = createSupervisorToolEvidence(request, {
    head: options.skillReadHead,
    callId: options.call.callId,
    toolResults: options.toolResults,
  });
  const contextCompaction = createSessionMemoryAwareCompactionController(
    request,
    createPolicyModelStepCompactionController(request, {
      consumer: SUPERVISOR_DECISION_MODEL_STEP,
      ...(supervisorToolEvidence ? { supervisorToolEvidence } : {}),
      superFailureOwner: superCompactionFailureOwner(
        request.executionPolicy.authority,
        {
          requestId: request.requestId,
          callId: options.call.callId,
          parentCallId: options.call.parentCallId,
          contractId: "supervisor",
          invocationAttempt: options.call.invocationAttempt,
          sourceRevision: options.toolResults.sourceRevision,
          modelStep: SUPERVISOR_DECISION_MODEL_STEP,
          phase: "compaction",
          scopeId: `role:supervisor:${options.call.callId}:continuation`,
        },
      ),
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
    }, request.executionPolicy.authority),
  );

  let resumeSkillFusionDeferred = false;
  for (;;) {
    const resumeSkillRouting = resumeSkillFusionDeferred ? undefined : prepareSupervisorResumeSkillRouting(request, {
      ...options, skillSelectionWindow,
    });
    const preparation = await prepareSupervisorDecision(request, {
      diagnostic: baseDiagnostic,
      includeAcknowledgement: options.resume === undefined && options.includeAcknowledgement === true,
      includeTitle: options.resume === undefined && (options.includeTitle ?? request.shouldGenerateSessionTitle ?? false),
      allowSkillReads: !resumeSkillRouting && request.knowledgeSkillStore !== undefined && options.allowSkillReads !== false,
      skillReadHead: options.skillReadHead,
      ...(options.resume ? { resume: options.resume } : {}),
      skillSelectionWindow,
      boundSteeringVersion,
    });
    assertBoundModelStepSteeringCurrent(requestSteering, preparation.steeringVersion);
    if (isSupervisorSkillLookup(preparation.selection)) {
      return createDecisionOutcome({ ...preparation.selection, ...preparation.presentation }, preparation.steeringVersion);
    }
    let input = buildSupervisorDecisionInput(request, {
      allowSkillAuthoring: canOfferSupervisorSkillAuthoring(request, options),
      allowMemoryRecall: canRecallSupervisorMemory(procedureState, {
        enabled: request.longTermMemory?.enabled === true,
        recallCount: options.memoryRecallCount ?? 0,
        maxRecallCallsPerRequest: request.memoryRecallLimit,
      }),
      ...(memoryRecallMessage ? { memoryRecallMessage } : {}),
      ...(initialMemoryMessage ? { initialMemoryMessage } : {}),
      ...buildSupervisorCapabilityBriefOptions(request, options),
      toolResults: options.toolResults,
      ...(supervisorToolEvidence ? { supervisorToolEvidence } : {}),
      ...(options.skillReadHead ? { skillReadHead: options.skillReadHead } : {}),
      includeAcknowledgement: false,
      includeTitle: false,
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
    if (resumeSkillRouting) {
      input = extendSupervisorResumeSkillRoutingInput(input, resumeSkillRouting);
      if (!canAdmitSupervisorResumeSkillRouting(request, input, contextCompaction)) {
        resumeSkillFusionDeferred = true;
        continue;
      }
    }
    const memoryRouting = await prepareSupervisorMemoryRouting(request, {
      input, resume: options.resume, steeringVersion: preparation.steeringVersion, contextCompaction,
    });
    const createRoutingCompaction = (format: ModelGatewayJsonSchemaFormat) =>
      createSupervisorArtifactPathsReadmissionController(request, {
        projection: input.artifactPathsProjection, format, includeInstructions: true,
        controller: createSupervisorCapabilityBriefReadmissionController(request, {
          input: { ...input, format }, controller: contextCompaction,
        }),
      });
    let routing: Awaited<ReturnType<typeof runRoutingPhase>>;
    try {
      routing = await runRoutingPhase({
        request,
        requestSteering,
        boundSteeringVersion: preparation.steeringVersion,
        input,
        resumeSkillRouting,
        memoryRouting: memoryRouting ? {
          ...memoryRouting,
          contextCompaction: preserveSupervisorMemoryRoutingContext(
            createRoutingCompaction(memoryRouting.format), {
              ...memoryRouting,
              // Pin the whole fused appendix, including complete Skill metadata.
              instructionAppendix: [resumeSkillRouting?.instructionAppendix, memoryRouting.instructionAppendix].filter(Boolean).join("\n\n"),
            },
          ),
        } : undefined,
        diagnostic: routingDiagnostic,
        contextCompaction: resumeSkillRouting
          ? preserveSupervisorMemoryRoutingContext(createRoutingCompaction(input.format), resumeSkillRouting)
          : createRoutingCompaction(input.format),
      });
    } catch (error) {
      request.abortSignal.throwIfAborted();
      if (!resumeSkillRouting) throw error;
      if (error instanceof SupervisorResumeSkillRoutingBudgetFallback) {
        resumeSkillFusionDeferred = true;
        continue;
      }
      if (!isExhaustedDuplicateSkillSelection(error)) throw error;
      assertBoundModelStepSteeringCurrent(requestSteering, preparation.steeringVersion);
      skillSelectionWindow.complete();
      traceDebug("runtime.supervisor", "skill_selection.rejected", {
        ...routingDiagnostic, steeringVersion: preparation.steeringVersion,
        issues: error.issues.map(({ code, path }) => ({ code, path })),
        repairAttempts: error.repairAttempts, disposition: "continue_routing",
      });
      continue;
    }
    if (resumeSkillRouting) {
      assertBoundModelStepSteeringCurrent(requestSteering, routing.steeringVersion);
      skillSelectionWindow.complete();
    }
    if (routing.decision.action === "read_skills")
      return createDecisionOutcome(routing.decision, routing.steeringVersion);
    if (routing.decision.action === "author_skill") {
      const authored = await runSupervisorSkillAuthoring(request, {
        ...options, diagnostic: baseDiagnostic,
        boundSteeringVersion: routing.steeringVersion, contextCompaction,
      });
      return createDecisionOutcome({ ...authored.decision, ...preparation.presentation }, authored.steeringVersion);
    }
    if (
      routing.decision.action === "invoke_role" &&
      routing.decision.roleId === "reviewer"
    ) {
      return createDecisionOutcome(
        Object.freeze({
          ...routing.decision,
          ...preparation.presentation,
          objective: resolveCanonicalReviewerCompletionTargetText(
            request.prompt,
          ),
        }),
        routing.steeringVersion,
      );
    }
    if (!requiresWorkingDirectory(routing.decision)) {
      return createDecisionOutcome({ ...routing.decision, ...preparation.presentation }, routing.steeringVersion, routing.memoryCandidates);
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
        filesystemScope: request.workerCapabilities.filesystemScope,
        diagnostic: workingDirectoryDiagnostic,
      },
    );
    const workingDirectory = await runWorkingDirectoryPhase({
      request,
      requestSteering,
      input: workingDirectoryInput,
      boundSteeringVersion,
      frozenDecision: routing.decision,
      artifactPathsProjection: input.artifactPathsProjection,
      diagnostic: workingDirectoryDiagnostic,
      contextCompaction: createSupervisorArtifactPathsReadmissionController(
        request,
        {
          projection: input.artifactPathsProjection,
          format: workingDirectoryInput.format,
          includeInstructions: false,
          controller: contextCompaction,
        },
      ),
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

    return createDecisionOutcome({ ...merged, ...preparation.presentation }, workingDirectory.steeringVersion);
  }
}
