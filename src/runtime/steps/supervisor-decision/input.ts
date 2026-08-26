import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { resolveConfiguredStepInstructionMetadata } from "../../config/runner/step-instructions.js";
import type { RequestContextProjection } from "../../context/request-context-contracts.js";
import { projectRequestContext } from "../../context/request-context.js";
import { projectRootSessionMemory } from "../../context/session-memory/root-projection.js";
import { buildRequestTemporalContextMessage } from "../../context/request-temporal-context.js";
import {
  buildRequestToolResultsMessage,
  type RequestToolResultsView,
} from "../../context/request-tool-results.js";
import { resolveModelContextBudget } from "../../model/model-context-budget.js";
import {
  WORKER_CAPABILITY_COUNT_MAX,
  WORKER_CAPABILITY_SUMMARY_MAX_LENGTH,
  type WorkerCapabilityCatalogGroup,
} from "../../orchestration/worker-capabilities/index.js";
import type { RequestExecutionSeed } from "../../request/contracts.js";
import {
  SUPERVISOR_DECISION_MODEL_STEP,
  SUPERVISOR_DELEGATE_ROLE_IDS,
  type SupervisorDecisionDiagnosticContext,
  type SupervisorDelegateRoleId,
  type SupervisorResumeContext,
  type SupervisorWorkerCapabilityAffordance,
} from "./contracts.js";
import {
  traceSupervisorChildResultProjected,
  traceSupervisorContextProjected,
} from "./diagnostics.js";
import { createSupervisorDecisionFormat } from "./format.js";
import { buildSupervisorDecisionInstructions } from "./prompt.js";
import { buildSupervisorContinuationPart } from "./resume.js";

export type SupervisorDecisionInputRequest = Pick<
  RequestExecutionSeed,
  | "requestId"
  | "prompt"
  | "historyMessages"
  | "runnerConfig"
  | "attachments"
  | "agentMode"
  | "modelPreference"
  | "modelPolicy"
> &
  Partial<
    Pick<
      RequestExecutionSeed,
      | "shouldGenerateSessionTitle"
      | "onEvent"
      | "temporalContext"
      | "sessionMemory"
    >
  >;

export function buildSupervisorDecisionInput(
  request: SupervisorDecisionInputRequest,
  options: Readonly<{
    toolResults: RequestToolResultsView;
    includeAcknowledgement?: boolean;
    includeTitle?: boolean;
    allowedRoleIds?: readonly SupervisorDelegateRoleId[];
    diagnostic?: SupervisorDecisionDiagnosticContext;
    resume?: SupervisorResumeContext;
    workerCapabilityAffordances?: readonly SupervisorWorkerCapabilityAffordance[];
    availableWorkerCapabilityCatalog?: readonly WorkerCapabilityCatalogGroup[];
  }>,
): {
  context: RequestContextProjection;
  format: ModelGatewayJsonSchemaFormat;
  modelStep: typeof SUPERVISOR_DECISION_MODEL_STEP;
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  allowedRoleIds: readonly SupervisorDelegateRoleId[];
  workerCapabilityAffordances: readonly SupervisorWorkerCapabilityAffordance[];
  availableWorkerCapabilityCatalog: readonly WorkerCapabilityCatalogGroup[];
} {
  if (options.resume && options.includeTitle === true) {
    throw new Error("supervisor_resume_title_not_allowed");
  }
  if (options.resume && options.includeAcknowledgement === true) {
    throw new Error("supervisor_resume_acknowledgement_not_allowed");
  }
  const includeAcknowledgement = options.resume
    ? false
    : options.includeAcknowledgement === true;
  const includeTitle = options.resume
    ? false
    : (options.includeTitle ?? request.shouldGenerateSessionTitle ?? false);
  const allowedRoleIds = [
    ...new Set(options.allowedRoleIds ?? SUPERVISOR_DELEGATE_ROLE_IDS),
  ];
  const availableWorkerCapabilityCatalog = allowedRoleIds.includes("worker")
    ? (options.availableWorkerCapabilityCatalog ??
      EMPTY_WORKER_CAPABILITY_CATALOG)
    : EMPTY_WORKER_CAPABILITY_CATALOG;
  const workerCapabilityAffordances =
    allowedRoleIds.includes("worker") &&
    availableWorkerCapabilityCatalog.length === 0
      ? normalizeWorkerCapabilityAffordances(
          options.workerCapabilityAffordances,
        )
      : EMPTY_WORKER_CAPABILITY_AFFORDANCES;
  const format = createSupervisorDecisionFormat({
    includeAcknowledgement,
    includeTitle,
    allowedRoleIds,
    availableWorkerCapabilityCatalog,
  });
  const diagnostic =
    options.diagnostic ??
    ({
      requestId: request.requestId,
      modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    } satisfies SupervisorDecisionDiagnosticContext);
  const roleContinuationPart = options.resume
    ? buildSupervisorContinuationPart({
        resume: options.resume,
        currentCallId: requireSupervisorCallId(diagnostic),
        currentInvocationAttempt:
          requireSupervisorInvocationAttempt(diagnostic),
      })
    : undefined;
  const referenceMessages = [
    ...(request.temporalContext
      ? [buildRequestTemporalContextMessage(request.temporalContext)]
      : []),
    ...(options.toolResults.results.length > 0
      ? [buildRequestToolResultsMessage(options.toolResults)]
      : []),
  ];
  const budget = resolveModelContextBudget({
    runnerConfig: request.runnerConfig,
    agentMode: request.agentMode,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    ...(request.modelPreference
      ? { modelPreference: request.modelPreference }
      : {}),
    ...(request.modelPolicy ? { modelPolicy: request.modelPolicy } : {}),
  });
  const configuredInstructionMetadata =
    resolveConfiguredStepInstructionMetadata({
      runnerConfig: request.runnerConfig,
      modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    });
  const instructions = buildSupervisorDecisionInstructions({
    includeAcknowledgement,
    includeTitle,
    allowedRoleIds,
    hasCompletedChildResult: options.resume !== undefined,
    hasRequestToolResults: options.toolResults.results.length > 0,
    workerCapabilityAffordances,
    availableWorkerCapabilityCatalog,
  });
  const sessionMemory = projectRootSessionMemory(request);
  const context = projectRequestContext({
    instructions,
    format,
    ...sessionMemory,
    prompt: request.prompt,
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(referenceMessages.length > 0 ? { referenceMessages } : {}),
    ...(roleContinuationPart
      ? { continuationParts: [roleContinuationPart] }
      : {}),
    budget,
    diagnostic,
    ...(request.onEvent ? { onEvent: request.onEvent } : {}),
    deferCompactionFailure: true,
  });

  traceSupervisorContextProjected({
    diagnostic,
    context,
    format,
    historyMessageCount: sessionMemory.historyMessages.length,
    attachmentCount: request.attachments?.length ?? 0,
    referenceMessageCount: referenceMessages.length,
    continuationMessageCount: roleContinuationPart?.messages.length ?? 0,
    completedChildResultCount: options.resume?.completedChildren.length ?? 0,
    completedChildSummaryLength:
      options.resume?.completedChildren.reduce(
        (total, child) => total + child.summary.length,
        0,
      ) ?? 0,
    allowedRoleIds,
    workerCapabilityAffordances,
    availableWorkerCapabilityCatalog,
    configuredInstructionBlockCount: configuredInstructionMetadata.blockCount,
    configuredInstructionCharacterCount:
      configuredInstructionMetadata.characterCount,
    configuredInstructionRefs: configuredInstructionMetadata.refs,
    configuredInstructionContentHashes:
      configuredInstructionMetadata.contentHashes,
  });
  if (options.resume) {
    traceSupervisorChildResultProjected({
      diagnostic,
      resume: options.resume,
      continuationMessageCount: roleContinuationPart?.messages.length ?? 0,
    });
  }

  return {
    context,
    format,
    modelStep: SUPERVISOR_DECISION_MODEL_STEP,
    includeAcknowledgement,
    includeTitle,
    allowedRoleIds,
    workerCapabilityAffordances,
    availableWorkerCapabilityCatalog,
  };
}

const EMPTY_WORKER_CAPABILITY_AFFORDANCES: readonly SupervisorWorkerCapabilityAffordance[] =
  Object.freeze([]);
const EMPTY_WORKER_CAPABILITY_CATALOG: readonly WorkerCapabilityCatalogGroup[] =
  Object.freeze([]);

function normalizeWorkerCapabilityAffordances(
  value: readonly SupervisorWorkerCapabilityAffordance[] | undefined,
): readonly SupervisorWorkerCapabilityAffordance[] {
  if (value === undefined) {
    return EMPTY_WORKER_CAPABILITY_AFFORDANCES;
  }
  if (!Array.isArray(value) || value.length > WORKER_CAPABILITY_COUNT_MAX) {
    throw new Error("supervisor_worker_capability_affordances_invalid");
  }
  return Object.freeze(
    value.map((affordance) => {
      const purpose =
        typeof affordance?.purpose === "string"
          ? affordance.purpose.trim()
          : "";
      if (
        purpose.length === 0 ||
        purpose.length > WORKER_CAPABILITY_SUMMARY_MAX_LENGTH ||
        (affordance.effect !== "observation" &&
          affordance.effect !== "mutation" &&
          affordance.effect !== "mixed")
      ) {
        throw new Error("supervisor_worker_capability_affordances_invalid");
      }
      return Object.freeze({
        purpose,
        effect: affordance.effect,
      });
    }),
  );
}

function requireSupervisorCallId(
  diagnostic: SupervisorDecisionDiagnosticContext,
): string {
  if (!diagnostic.callId) {
    throw new Error("supervisor_resume_call_identity_required");
  }
  return diagnostic.callId;
}

function requireSupervisorInvocationAttempt(
  diagnostic: SupervisorDecisionDiagnosticContext,
): number {
  if (
    typeof diagnostic.invocationAttempt !== "number" ||
    !Number.isSafeInteger(diagnostic.invocationAttempt) ||
    diagnostic.invocationAttempt < 1
  ) {
    throw new Error("supervisor_resume_invocation_attempt_required");
  }
  return diagnostic.invocationAttempt;
}
