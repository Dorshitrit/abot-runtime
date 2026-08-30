import {
  invokeStructuredModelStep,
  StructuredModelInvalidOutputError,
} from "../../model/invoke-structured-step.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
} from "../../orchestration/role-calls/index.js";
import { createRoleCapabilitySelectionProjection } from "../../orchestration/role-calls/index.js";
import type { RequestExecutionScope } from "../../request/execution-scope.js";
import type { RequestSteeringSnapshot } from "../../request/request-steering.js";
import type {
  ExecutionAgentCapabilityInvocation,
  ExecutionAgentDecision,
  ExecutionAgentDecisionOutcome,
  ExecutionAgentResolvedDecision,
} from "./contracts.js";
import {
  EXECUTION_AGENT_DECISION_MODEL_STEP,
  EXECUTION_AGENT_RESPONSE_MODEL_STEP,
} from "./contracts.js";
import { createExecutionAgentCompactionController } from "./compaction.js";
import { createSessionMemoryAwareCompactionController } from "../../context/session-memory/index.js";
import { buildExecutionAgentInput } from "./input.js";
import { parseExecutionAgentDecisionOutput } from "./parser.js";
import { refineExecutionCapabilityInvocations } from "./refinement.js";
import { createRefinementInvalidOutputCause } from "./refinement-reconsideration.js";

type RunExecutionAgentDecisionOptions = Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  steeringSnapshot: RequestSteeringSnapshot;
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  allowPlanner: boolean;
  allowAuditor: boolean;
}>;

export async function runExecutionAgentDecision(
  request: RequestExecutionScope,
  options: RunExecutionAgentDecisionOptions,
): Promise<ExecutionAgentDecisionOutcome> {
  const input = buildExecutionAgentInput(request, options);
  const accepted = await invokeStructuredModelStep({
    request,
    modelStep: input.modelStep,
    format: input.format,
    messages: input.messages,
    contextCompaction: createSessionMemoryAwareCompactionController(
      request,
      createExecutionAgentCompactionController(request, {
        call: options.call,
        sourceRevision: options.head.revision,
        allowedConsumers: Object.freeze([
          EXECUTION_AGENT_DECISION_MODEL_STEP,
          EXECUTION_AGENT_RESPONSE_MODEL_STEP,
        ]),
      }),
    ),
    timeoutReason: "execution_agent_decision_timeout",
    invalidOutputReason: "invalid_execution_agent_decision",
    parse: (text) => {
      const parsed = parseExecutionAgentDecisionOutput(text, input.contract);
      return parsed.ok
        ? Object.freeze({
            ok: true as const,
            decision: Object.freeze({
              decision: parsed.decision,
              steeringVersion: options.steeringSnapshot.version,
            }),
          })
        : parsed;
    },
  });
  const decision = await refineDecision(
    request,
    options,
    input.capabilities,
    input.eligibleSessionArtifactPaths,
    accepted.decision,
  );
  return Object.freeze({
    decision,
    steeringVersion: accepted.steeringVersion,
  });
}

async function refineDecision(
  request: RequestExecutionScope,
  options: Readonly<{
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
    steeringSnapshot: RequestSteeringSnapshot;
  }>,
  capabilities: ReturnType<typeof buildExecutionAgentInput>["capabilities"],
  eligibleSessionArtifactPaths: ReturnType<
    typeof buildExecutionAgentInput
  >["eligibleSessionArtifactPaths"],
  decision: ExecutionAgentDecision,
): Promise<ExecutionAgentResolvedDecision> {
  if (
    decision.action !== "invoke_capability" &&
    decision.action !== "invoke_capabilities"
  ) {
    return decision;
  }
  const invocations =
    decision.action === "invoke_capability" ? [decision] : decision.invocations;
  let refined: Awaited<ReturnType<typeof refineExecutionCapabilityInvocations>>;
  try {
    refined = await refineExecutionCapabilityInvocations(request, {
      head: options.head,
      call: options.call,
      capabilities,
      eligibleSessionArtifactPaths,
      invocations,
      steeringSnapshot: options.steeringSnapshot,
    });
  } catch (error: unknown) {
    if (!(error instanceof StructuredModelInvalidOutputError)) throw error;
    return reconsiderCapabilitySelection(
      options,
      decision,
      invocations,
      createRefinementInvalidOutputCause(error),
    );
  }
  if (decision.action === "invoke_capability") {
    const { operationObjective: _operationObjective, ...resolvedDecision } =
      decision;
    return Object.freeze({
      ...resolvedDecision,
      controls: refined.invocations[0]!.controls,
    });
  }
  return Object.freeze({
    ...decision,
    invocations: refined.invocations,
  });
}

function reconsiderCapabilitySelection(
  options: Readonly<{
    call: RoleCallFrame;
  }>,
  decision: Extract<
    ExecutionAgentDecision,
    { action: "invoke_capability" | "invoke_capabilities" }
  >,
  invocations: readonly ExecutionAgentCapabilityInvocation[],
  cause: Extract<
    ExecutionAgentResolvedDecision,
    { action: "reconsider_capability_selection" }
  >["cause"],
): ExecutionAgentResolvedDecision {
  const activeCapabilityCatalogGroupIds =
    options.call.workerCapabilityScope?.catalogGroupIds;
  if (!activeCapabilityCatalogGroupIds) {
    throw new Error("execution_capability_reconsideration_scope_missing");
  }
  return Object.freeze({
    action: "reconsider_capability_selection" as const,
    selection: createRoleCapabilitySelectionProjection({
      action: decision.action,
      invocations,
      workingDirectory:
        options.call.workingDirectory ?? decision.workingDirectory ?? null,
      activeCapabilityCatalogGroupIds,
    }),
    cause,
  });
}
