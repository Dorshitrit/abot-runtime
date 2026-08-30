import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { projectRequestContext } from "../../context/request-context.js";
import { projectRootSessionMemory } from "../../context/session-memory/root-projection.js";
import { buildRequestTemporalContextMessage } from "../../context/request-temporal-context.js";
import { buildImmediateOperationSupervisionEvidenceMessage } from "../../context/operation-supervision-evidence.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import {
  CAPABILITY_COUNT_MAX,
  projectCapabilityCatalogGroups,
  projectCapabilityScope,
  type CapabilityCatalogGroup,
  type CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";
import {
  resolveRequestWorkerCapabilities,
  type RequestExecutionScope,
} from "../../request/execution-scope.js";
import { appendRequestSteeringContext } from "../../request/request-steering-context.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import { EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID } from "../auditor-decision/index.js";
import {
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  type ExecutionAgentDecisionContractOptions,
} from "./contracts.js";
import { createExecutionAgentDecisionFormat } from "./format.js";
import { buildExecutionAgentInstructions } from "./prompt.js";
import {
  buildExecutionCapabilityCatalogMessage,
  buildExecutionCapabilityGroupCatalogMessage,
  buildExecutionContinuationMessages,
  buildExecutionDecisionStateMessage,
} from "./state-context.js";

export type ExecutionAgentInput = Readonly<{
  context: RequestContextProjection;
  messages: ReturnType<typeof appendRequestSteeringContext>;
  format: ModelGatewayJsonSchemaFormat;
  contract: ExecutionAgentDecisionContractOptions;
  modelStep: typeof EXECUTION_AGENT_DECISION_MODEL_STEP;
  capabilityCatalogGroups: readonly CapabilityCatalogGroup[];
  capabilities: readonly CapabilityDescriptor[];
  eligibleSessionArtifactPaths: readonly string[];
}>;

type BuildExecutionAgentInputOptions = Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  steeringSnapshot: RequestSteeringSnapshot;
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  allowPlanner: boolean;
  allowAuditor: boolean;
}>;

export function buildExecutionAgentInput(
  request: RequestExecutionScope,
  options: BuildExecutionAgentInputOptions,
): ExecutionAgentInput {
  assertCanonicalSource(request, options.head, options.call);
  const allCapabilities =
    resolveRequestWorkerCapabilities(request).provider.getDescriptors();
  const capabilityCatalogGroups =
    projectCapabilityCatalogGroups(allCapabilities);
  const activeCapabilityCatalogGroupIds =
    options.call.workerCapabilityScope?.catalogGroupIds ?? null;
  const eligibleSessionArtifactPaths = projectEligibleSessionArtifactPaths(
    request.sessionArtifactPaths,
    options.head,
    options.call,
  );
  const remainingExecutions =
    options.head.policy.limits.maxCapabilityExecutions -
    options.head.state.capabilityExecutions.length;
  const scopedCapabilities =
    activeCapabilityCatalogGroupIds !== null && remainingExecutions > 0
      ? projectCapabilityScope({
          entries: allCapabilities,
          scope: options.call.workerCapabilityScope,
          descriptorOf: (entry) => entry,
        }).entries
      : Object.freeze([]);
  const capabilities = scopedCapabilities;
  const knownGroupIds = Object.freeze(
    capabilityCatalogGroups.map(({ groupId }) => groupId),
  );
  const hasInactiveGroup =
    activeCapabilityCatalogGroupIds !== null &&
    knownGroupIds.some(
      (groupId) => !activeCapabilityCatalogGroupIds.includes(groupId),
    );
  const capabilityScopeAction =
    remainingExecutions <= 0 || knownGroupIds.length === 0
      ? null
      : activeCapabilityCatalogGroupIds === null
        ? ("open" as const)
        : hasInactiveGroup
          ? ("extend" as const)
          : null;
  const hasCurrentEvidence =
    options.head.state.capabilityExecutions.some(
      (execution) =>
        execution.callId === options.call.callId &&
        execution.status === "settled",
    ) ||
    options.head.state.results.some((result) => {
      const producer = options.head.state.calls.find(
        (candidate) => candidate.callId === result.producerCallId,
      );
      return producer?.parentCallId === options.call.callId;
    });
  const availableAuditCriterionIds =
    options.allowAuditor && hasCurrentEvidence
      ? Object.freeze([EXECUTION_AGENT_ROOT_AUDIT_CRITERION_ID])
      : Object.freeze([]);
  const contract = Object.freeze({
    capabilities,
    capabilityCatalogGroupIds: knownGroupIds,
    activeCapabilityCatalogGroupIds,
    maxBatchCapabilityExecutions: Math.min(
      CAPABILITY_COUNT_MAX,
      Math.max(0, remainingExecutions),
    ),
    includeAcknowledgement: options.includeAcknowledgement,
    includeTitle: options.includeTitle,
    allowRespond: true,
    allowPlanner: options.allowPlanner,
    allowAuditor: availableAuditCriterionIds.length > 0,
    availableAuditCriterionIds,
    includeWorkingDirectory: options.call.workingDirectory === undefined,
  } satisfies ExecutionAgentDecisionContractOptions);
  const format = createExecutionAgentDecisionFormat(contract);
  const instructions = buildExecutionAgentInstructions({
    hasCapabilities: capabilities.length > 0,
    hasCapabilityCatalogGroups: capabilityCatalogGroups.length > 0,
    capabilityScopeAction,
    allowPlanner: options.allowPlanner,
    availableAuditCriterionCount: availableAuditCriterionIds.length,
    allowRespond: true,
    includeAcknowledgement: options.includeAcknowledgement,
    includeTitle: options.includeTitle,
    includeWorkingDirectory: options.call.workingDirectory === undefined,
  });
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const operationSupervisionEvidenceMessage =
    buildImmediateOperationSupervisionEvidenceMessage(
      options.head,
      options.call,
    );
  const referenceMessages = [
    ...(request.temporalContext
      ? [buildRequestTemporalContextMessage(request.temporalContext)]
      : []),
    buildExecutionDecisionStateMessage(
      options.head,
      options.call,
      options.steeringSnapshot.version,
    ),
    ...(operationSupervisionEvidenceMessage
      ? [operationSupervisionEvidenceMessage]
      : []),
    buildExecutionCapabilityGroupCatalogMessage(capabilityCatalogGroups),
    ...(capabilities.length > 0
      ? [buildExecutionCapabilityCatalogMessage(capabilities)]
      : []),
  ];
  const continuationMessages = buildExecutionContinuationMessages(
    options.head,
    options.call,
  );
  const sessionMemory = projectRootSessionMemory(request);
  const context = projectRequestContext({
    instructions,
    format,
    ...sessionMemory,
    prompt: request.prompt,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    referenceMessages,
    ...(continuationMessages.length > 0 ? { continuationMessages } : {}),
    deferCompactionFailure: true,
    budget,
    diagnostic: {
      requestId: request.requestId,
      modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
      callId: options.call.callId,
    },
    onEvent: request.onEvent,
  });
  return Object.freeze({
    context,
    messages: appendRequestSteeringContext(
      context.messages,
      options.steeringSnapshot,
    ),
    format,
    contract,
    modelStep: EXECUTION_AGENT_DECISION_MODEL_STEP,
    capabilityCatalogGroups,
    capabilities,
    eligibleSessionArtifactPaths,
  });
}

function projectEligibleSessionArtifactPaths(
  sessionArtifactPaths: readonly string[] | undefined,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): readonly string[] {
  if (!sessionArtifactPaths || sessionArtifactPaths.length === 0) {
    return Object.freeze([]);
  }
  const currentRequestTargets = new Set(
    head.state.capabilityExecutions
      .filter(
        (execution) =>
          execution.callId === call.callId && execution.status === "settled",
      )
      .flatMap((execution) =>
        (execution.references ?? [])
          .filter((reference) => reference.kind === "tool_target")
          .map((reference) => reference.target),
      ),
  );
  return Object.freeze(
    sessionArtifactPaths
      .slice(0, 8)
      .filter((target) => !currentRequestTargets.has(target)),
  );
}

function assertCanonicalSource(
  request: RequestExecutionScope,
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): void {
  if (
    head.state.requestId !== request.requestId ||
    head.state.phase !== "running" ||
    head.state.rootCallId !== call.callId ||
    head.state.activeCallId !== call.callId ||
    call.parentCallId !== null ||
    call.status !== "active"
  ) {
    throw new Error("execution_agent_head_invalid");
  }
}
