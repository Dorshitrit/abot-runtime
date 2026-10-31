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
import type { ChatMessage } from "../../../model-gateway/types.js";
import type { RoleCallLedgerHead } from "../../orchestration/role-calls/index.js";

import { createDecisionOutcome, runRoutingPhase, runWorkingDirectoryPhase, requiresWorkingDirectory, tracePhaseSuperseded } from "./decision-phases.js";
import { prepareSupervisorDecision } from "./preparation.js";
import { isSupervisorSkillLookup } from "./skill-selection.js";
import { assertBoundModelStepSteeringCurrent } from "../../model/model-step-steering.js";
import { canOfferSupervisorSkillAuthoring } from "../supervisor-skill-authoring/input.js";
import { runSupervisorSkillAuthoring } from "../supervisor-skill-authoring/run.js";
import { canRecallSupervisorMemory, projectSupervisorProcedureEntry } from "./procedure-entry.js";
import { traceDebug } from "../../observability/debug-logger.js";
import { runSupervisorProcedureGate } from "./procedure-gate.js";
import { buildSupervisorDelegationInput } from "./delegation-input.js";

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
  // Eligibility and recalled facts describe this exact intent, including when
  // the canonical receipt was omitted by the caller and regenerated above.
  const boundSteeringVersion = procedureEntry ? entrySteeringVersion : recallSteeringVersion;
  traceDebug("runtime.supervisor", "procedure.entry.projected", {
    ...baseDiagnostic, classifyProcedure: procedureEntry,
    allowInitialMemoryRecall: procedureState.allowInitialMemoryRecall,
    hasRecallReceipt: procedureState.memoryRecallMessage !== undefined,
    steeringVersion: entrySteeringVersion,
  });
  const routingDiagnostic: SupervisorDecisionDiagnosticContext = Object.freeze({
    ...baseDiagnostic,
    decisionPhase: procedureEntry ? "delegation" : "routing",
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
  const contextCompaction = createSessionMemoryAwareCompactionController(
    request,
    createPolicyModelStepCompactionController(request, {
      consumer: SUPERVISOR_DECISION_MODEL_STEP,
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

  for (;;) {
    const preparation = await prepareSupervisorDecision(request, {
      diagnostic: baseDiagnostic,
      includeAcknowledgement: options.resume === undefined && options.includeAcknowledgement === true,
      includeTitle: options.resume === undefined && (options.includeTitle ?? request.shouldGenerateSessionTitle ?? false),
      allowSkillReads: request.knowledgeSkillStore !== undefined && options.allowSkillReads !== false,
      skillReadHead: options.skillReadHead,
      ...(options.resume ? { resume: options.resume } : {}),
      skillSelectionWindow,
      boundSteeringVersion,
    });
    assertBoundModelStepSteeringCurrent(requestSteering, preparation.steeringVersion);
    if (isSupervisorSkillLookup(preparation.selection)) {
      return createDecisionOutcome({ ...preparation.selection, ...preparation.presentation }, preparation.steeringVersion);
    }
    const gate = procedureEntry
      ? await runSupervisorProcedureGate(request, {
        diagnostic: { ...baseDiagnostic, decisionPhase: "procedure_gate" },
        skillReadHead: options.skillReadHead,
        boundSteeringVersion: preparation.steeringVersion,
        ...(initialMemoryMessage ? { initialMemoryMessage } : {}),
        ...(memoryRecallMessage ? { memoryRecallMessage } : {}),
      })
      : undefined;
    if (gate) assertBoundModelStepSteeringCurrent(requestSteering, gate.steeringVersion);
    if (gate?.decision.requiresProcedure === false) {
      return createDecisionOutcome({
        action: "respond",
        responseRecommendation: gate.decision.responseRecommendation,
        ...preparation.presentation,
      }, gate.steeringVersion);
    }
    const buildRoutingInput = procedureEntry
      ? buildSupervisorDelegationInput
      : buildSupervisorDecisionInput;
    const input = buildRoutingInput(request, {
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
    const routing = await runRoutingPhase({
      request,
      requestSteering,
      boundSteeringVersion: preparation.steeringVersion,
      input,
      diagnostic: routingDiagnostic,
      contextCompaction: createSupervisorArtifactPathsReadmissionController(
        request,
        {
          projection: input.artifactPathsProjection,
          format: input.format,
          includeInstructions: true,
          controller: createSupervisorCapabilityBriefReadmissionController(
            request,
            { input, controller: contextCompaction },
          ),
        },
      ),
    });
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
      return createDecisionOutcome({ ...routing.decision, ...preparation.presentation }, routing.steeringVersion);
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
      exactContext: procedureEntry,
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
