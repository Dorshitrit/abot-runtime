import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { resolveConfiguredStepInstructionMetadata } from "../../config/runner/step-instructions.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { projectRequestContext } from "../../context/request-context.js";
import { buildRequestTemporalContextMessage } from "../../context/request-temporal-context.js";
import {
  buildRequestSourceMessage,
  projectRequestSource,
} from "../../context/request-source.js";
import {
  buildRequestToolResultsMessage,
  type RequestToolResultsView,
} from "../../context/request-tool-results.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import {
  projectRoleCallDependencyResults,
  projectRoleChildReturnContext,
  type RoleCallFrame,
  type RoleCallChildReturnCommit,
  type RoleCallDependencyResult,
  type RoleCallLedger,
  type RoleCallLedgerHead,
  type RoleChildReturnContext,
} from "../../orchestration/role-calls/index.js";
import type { RuntimeDelegateRoleId } from "../../orchestration/roles.js";
import {
  resolveRequestWorkerCapabilityCatalog,
  type RequestWorkerCapabilityProviderSource,
} from "../../request/execution-scope.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import {
  PLANNER_DECISION_ACTIONS,
  PLANNER_DECISION_MODEL_STEP,
  projectPlannerDecisionCallIdentity,
  type PlannerChildRoleId,
  type PlannerDecision,
  type PlannerDecisionDiagnosticContext,
  type PlannerDecisionPlanContext,
  type PlannerDecisionSelectionKind,
} from "./contracts.js";
import {
  tracePlannerChildResultsProjected,
  tracePlannerContextProjected,
} from "./diagnostics.js";
import {
  createPlannerDecisionFormat,
  normalizeAvailableChildRoleIds,
} from "./format.js";
import {
  buildPlannerReferenceParts,
  projectPlannerWorkerCapabilityCatalogGroups,
  type PlannerWorkerCapabilityCatalogGroup,
} from "./capability-catalog-context.js";
import {
  normalizePlannerDecisionPlanContext,
  plannerPlanAllowsInvocation,
} from "./plan.js";
import { buildPlannerDecisionInstructions } from "./prompt.js";
import { buildPlannerChildContinuationPart } from "./resume.js";
import { projectPlannerToolResults } from "./tool-results.js";

export type PlannerDecisionInputRequest = Pick<
  RequestExecutionSeed,
  | "requestId"
  | "prompt"
  | "runnerConfig"
  | "agentMode"
  | "modelPreference"
  | "modelPolicy"
> &
  Partial<Pick<RequestExecutionSeed, "onEvent" | "temporalContext">> &
  RequestWorkerCapabilityProviderSource;

export type PlannerDecisionProgressSource = Readonly<{
  kind: "role_child";
  ledger: RoleCallLedger;
  commit: RoleCallChildReturnCommit;
}>;

export function buildPlannerDecisionInput(
  request: PlannerDecisionInputRequest,
  options: Readonly<{
    call: RoleCallFrame;
    availableChildRoleIds: readonly RuntimeDelegateRoleId[];
    toolResults: RequestToolResultsView;
    dependencyHead?: RoleCallLedgerHead;
    progress?: PlannerDecisionProgressSource;
    planContext?: PlannerDecisionPlanContext;
    diagnostic?: PlannerDecisionDiagnosticContext;
  }>,
): {
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  modelStep: typeof PLANNER_DECISION_MODEL_STEP;
  diagnostic: PlannerDecisionDiagnosticContext;
  allowedActions: readonly PlannerDecisionSelectionKind[];
  availableChildRoleIds: readonly PlannerChildRoleId[];
  dependencyResults: readonly RoleCallDependencyResult[];
  availableWorkerCapabilityCatalog: readonly PlannerWorkerCapabilityCatalogGroup[];
  inheritedWorkingDirectory?: string;
  planContext?: PlannerDecisionPlanContext;
  childResume?: RoleChildReturnContext;
} {
  const callIdentity = projectPlannerDecisionCallIdentity(options.call);
  const diagnostic =
    options.diagnostic ??
    ({
      requestId: request.requestId,
      modelStep: PLANNER_DECISION_MODEL_STEP,
      ...callIdentity,
    } satisfies PlannerDecisionDiagnosticContext);
  const configuredChildRoleIds = normalizeAvailableChildRoleIds(
    options.availableChildRoleIds,
  );
  const availableWorkerCapabilityCatalog = configuredChildRoleIds.includes(
    "worker",
  )
    ? projectPlannerWorkerCapabilityCatalogGroups(
        resolveRequestWorkerCapabilityCatalog(request).getDescriptors(),
      )
    : Object.freeze([]);
  const availableChildRoleIds = configuredChildRoleIds;
  const inheritedWorkingDirectory = options.call.workingDirectory;
  const planContext = options.planContext
    ? normalizePlannerDecisionPlanContext(options.planContext)
    : undefined;
  const childInvocationAvailable =
    availableChildRoleIds.length > 0 &&
    plannerPlanAllowsInvocation(planContext);
  const childResume = options.progress
    ? projectRoleChildReturnContext(
        options.progress.ledger,
        options.progress.commit,
      )
    : undefined;
  validatePlannerCanonicalContext({
    requestId: request.requestId,
    call: options.call,
    progressSource: options.progress,
    childResume,
  });
  const dependencyResults = options.dependencyHead
    ? projectRoleCallDependencyResults(options.dependencyHead, options.call)
    : requireNoUnresolvedDependencies(options.call);
  const allowedActions = Object.freeze([
    ...(planContext?.mode === "select"
      ? []
      : ([PLANNER_DECISION_ACTIONS[0]] as const)),
    PLANNER_DECISION_ACTIONS[1],
    ...(childInvocationAvailable ? [PLANNER_DECISION_ACTIONS[2]] : []),
  ]);
  const format = createPlannerDecisionFormat({
    availableChildRoleIds,
    availableWorkerCapabilityCatalog,
    ...(inheritedWorkingDirectory !== undefined
      ? { inheritedWorkingDirectory }
      : {}),
    ...(planContext ? { planContext } : {}),
  });
  const childContinuationPart = childResume
    ? buildPlannerChildContinuationPart({
        resume: childResume,
        currentCallId: callIdentity.callId,
        currentInvocationAttempt: callIdentity.invocationAttempt,
        ...(planContext ? { planContext } : {}),
      })
    : undefined;
  const requestSource = projectRequestSource({
    requestId: request.requestId,
    prompt: request.prompt,
    modelStep: PLANNER_DECISION_MODEL_STEP,
    callId: callIdentity.callId,
  });
  const toolResultsProjection = projectPlannerToolResults(options.toolResults);
  const referenceMessages = Object.freeze([
    ...(request.temporalContext
      ? [buildRequestTemporalContextMessage(request.temporalContext)]
      : []),
    buildRequestSourceMessage(requestSource),
    ...(toolResultsProjection.view.results.length > 0
      ? [buildRequestToolResultsMessage(toolResultsProjection.view)]
      : []),
  ]);
  const referenceParts = buildPlannerReferenceParts({
    callId: callIdentity.callId,
    invocationAttempt: callIdentity.invocationAttempt,
    exactMessages: referenceMessages,
    catalogGroups: availableWorkerCapabilityCatalog,
  });
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: PLANNER_DECISION_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const configuredInstructionMetadata =
    resolveConfiguredStepInstructionMetadata({
      runnerConfig: request.runnerConfig,
      modelStep: PLANNER_DECISION_MODEL_STEP,
    });
  const instructions = buildPlannerDecisionInstructions({
    childRolesAvailable: childInvocationAvailable,
    hasCompletedChildResults: childResume !== undefined,
    hasDependencyResults: dependencyResults.length > 0,
    workerRoleAvailable: availableChildRoleIds.includes("worker"),
    workerWorkingDirectoryInherited: inheritedWorkingDirectory !== undefined,
    workerCapabilityCatalogAvailable:
      availableWorkerCapabilityCatalog.length > 0,
    ...(planContext ? { planContext } : {}),
  });
  const context = projectRequestContext({
    instructions,
    format,
    historyMessages: [],
    prompt: JSON.stringify({
      kind: "runtime_planner_assignment",
      callId: callIdentity.callId,
      parentCallId: callIdentity.parentCallId,
      depth: callIdentity.depth,
      invocationAttempt: callIdentity.invocationAttempt,
      objective: options.call.objective!,
      ...(inheritedWorkingDirectory !== undefined
        ? { workingDirectory: inheritedWorkingDirectory }
        : {}),
      availableChildRoleIds,
      ...(dependencyResults.length > 0 ? { dependencyResults } : {}),
      ...(planContext ? { planContext } : {}),
      completedChildResultCount: childResume?.completedChildren.length ?? 0,
    }),
    referenceParts,
    ...(childContinuationPart
      ? { continuationParts: [childContinuationPart] }
      : {}),
    budget,
    diagnostic,
    ...(request.onEvent ? { onEvent: request.onEvent } : {}),
    deferCompactionFailure: true,
  });

  tracePlannerContextProjected({
    diagnostic,
    context,
    format,
    objectiveLength: options.call.objective!.length,
    workingDirectoryInherited: inheritedWorkingDirectory !== undefined,
    workingDirectoryLength: inheritedWorkingDirectory?.length ?? 0,
    availableChildRoleIds,
    workerCapabilityCatalogGroupIds: availableWorkerCapabilityCatalog.map(
      (group) => group.groupId,
    ),
    workerCapabilityCatalogMemberCount: availableWorkerCapabilityCatalog.reduce(
      (total, group) => total + group.memberCount,
      0,
    ),
    referenceMessageCount: referenceParts.reduce(
      (total, part) => total + part.messages.length,
      0,
    ),
    continuationMessageCount: childContinuationPart?.messages.length ?? 0,
    completedChildResultCount: childResume?.completedChildren.length ?? 0,
    completedChildSummaryLength:
      childResume?.completedChildren.reduce(
        (total, child) => total + child.summary.length,
        0,
      ) ?? 0,
    dependencyResultRefs: dependencyResults.map((result) => result.resultRef),
    dependencyResultSummaryLength: dependencyResults.reduce(
      (total, result) => total + result.summary.length,
      0,
    ),
    sourceToolResultCount: toolResultsProjection.sourceResultCount,
    projectedToolResultCount: toolResultsProjection.view.results.length,
    supersededToolResultCount: toolResultsProjection.supersededResultCount,
    retainedFailedToolResultCount:
      toolResultsProjection.retainedFailedResultCount,
    retainedUntargetedToolResultCount:
      toolResultsProjection.retainedUntargetedResultCount,
    allowedActions,
    configuredInstructionBlockCount: configuredInstructionMetadata.blockCount,
    configuredInstructionCharacterCount:
      configuredInstructionMetadata.characterCount,
    configuredInstructionRefs: configuredInstructionMetadata.refs,
    configuredInstructionContentHashes:
      configuredInstructionMetadata.contentHashes,
    ...(planContext ? { planContext } : {}),
  });
  if (childResume) {
    tracePlannerChildResultsProjected({
      diagnostic,
      resume: childResume,
      continuationMessageCount: childContinuationPart?.messages.length ?? 0,
    });
  }
  return {
    context,
    format,
    modelStep: PLANNER_DECISION_MODEL_STEP,
    diagnostic,
    allowedActions,
    availableChildRoleIds,
    dependencyResults,
    availableWorkerCapabilityCatalog,
    ...(inheritedWorkingDirectory !== undefined
      ? { inheritedWorkingDirectory }
      : {}),
    ...(planContext ? { planContext } : {}),
    ...(childResume ? { childResume } : {}),
  };
}

function requireNoUnresolvedDependencies(
  call: RoleCallFrame,
): readonly RoleCallDependencyResult[] {
  if (call.dependencyResultRefs.length > 0) {
    throw new Error("planner_dependency_source_missing");
  }
  return Object.freeze([]);
}

function validatePlannerCanonicalContext(params: {
  requestId: string;
  call: RoleCallFrame;
  progressSource?: PlannerDecisionProgressSource;
  childResume?: RoleChildReturnContext;
}): void {
  const childCount = params.call.childCallIds.length;
  if (
    (childCount === 0 && params.childResume !== undefined) ||
    (childCount > 0 && params.childResume === undefined)
  ) {
    throw new Error("planner_child_resume_presence_invalid");
  }
  if (!params.progressSource) {
    if (params.call.activationCount !== 1) {
      throw new Error("planner_initial_activation_invalid");
    }
    return;
  }
  const head = params.progressSource.commit.head;
  const canonicalCall = head?.state.calls.find(
    (candidate) => candidate.callId === head.state.activeCallId,
  );
  if (
    head?.state.requestId !== params.requestId ||
    canonicalCall !== params.call ||
    params.childResume?.callerCallId !== params.call.callId ||
    params.childResume.invocationAttempt !== params.call.activationCount ||
    params.childResume.completedChildren.length !== childCount
  ) {
    throw new Error("planner_child_resume_source_mismatch");
  }
}
