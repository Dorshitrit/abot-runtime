import type { ChatMessage } from "../../../model-gateway/types.js";
import type { MemoryRecallContinuation } from "../../long-term-memory/recall-continuation.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../../orchestration/role-calls/index.js";
import { projectImmediateRoleOperationSupervisionNotices } from "../../orchestration/role-calls/index.js";
import { projectImmediateCapabilityReconsideration } from "./reconsideration-context.js";
import type {
  CapabilityCatalogGroup,
  CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";

export const EXECUTION_STATE_MESSAGE_KIND =
  "runtime_execution_state_v1" as const;
export const EXECUTION_CAPABILITY_CATALOG_MESSAGE_KIND =
  "runtime_execution_capability_catalog_v1" as const;
export const EXECUTION_CAPABILITY_GROUP_CATALOG_MESSAGE_KIND =
  "runtime_execution_capability_group_catalog_v1" as const;
export const EXECUTION_AGENT_ACTION_MESSAGE_KIND =
  "runtime_execution_agent_action_v1" as const;
export const EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND =
  "runtime_execution_capability_result_v1" as const;
export { EXECUTION_CAPABILITY_RECONSIDERATION_MESSAGE_KIND } from "./reconsideration-context.js";
export const EXECUTION_CAPABILITY_TOOL_NAME = "runtime_capability" as const;

type ExecutionStateNoticeProjection = Readonly<{
  includeCapabilitySelectionReconsideration: boolean;
  includeOperationSupervision: boolean;
}>;

const NON_DECISION_NOTICE_PROJECTION: ExecutionStateNoticeProjection =
  Object.freeze({
    includeCapabilitySelectionReconsideration: false,
    includeOperationSupervision: false,
  });

const DECISION_NOTICE_PROJECTION: ExecutionStateNoticeProjection =
  Object.freeze({
    includeCapabilitySelectionReconsideration: true,
    includeOperationSupervision: true,
  });

export function buildExecutionStateMessage(
  head: RoleCallLedgerHead,
  call: RoleCallFrame = requireActiveRootCall(head),
): ChatMessage {
  return buildExecutionStateMessageForConsumer(
    head,
    call,
    NON_DECISION_NOTICE_PROJECTION,
  );
}

export function buildExecutionDecisionStateMessage(
  head: RoleCallLedgerHead,
  call: RoleCallFrame = requireActiveRootCall(head),
  steeringVersion?: number,
): ChatMessage {
  return buildExecutionStateMessageForConsumer(
    head,
    call,
    DECISION_NOTICE_PROJECTION,
    steeringVersion,
  );
}

export function buildExecutionRefinementStateMessage(
  head: RoleCallLedgerHead,
  call: RoleCallFrame = requireActiveRootCall(head),
): ChatMessage {
  return buildExecutionStateMessage(head, call);
}

export function buildExecutionResponseStateMessage(
  head: RoleCallLedgerHead,
  call: RoleCallFrame = requireActiveRootCall(head),
): ChatMessage {
  return buildExecutionStateMessage(head, call);
}

function buildExecutionStateMessageForConsumer(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
  projection: ExecutionStateNoticeProjection,
  steeringVersion?: number,
): ChatMessage {
  assertExecutionRoot(head, call);
  const immediateReconsideration =
    projection.includeCapabilitySelectionReconsideration
      ? projectImmediateCapabilityReconsideration(head, call, steeringVersion)
      : undefined;
  const operationSupervision = projection.includeOperationSupervision
    ? projectImmediateRoleOperationSupervisionNotices(head, call)
    : Object.freeze([]);
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: EXECUTION_STATE_MESSAGE_KIND,
      authority: "runtime_state",
      stateRevision: head.revision,
      callId: call.callId,
      activationCount: call.activationCount,
      workingDirectory: call.workingDirectory ?? null,
      activeCapabilityScope: call.workerCapabilityScope ?? null,
      settledCapabilityExecutionCount: head.state.capabilityExecutions.filter(
        (execution) =>
          execution.callId === call.callId && execution.status === "settled",
      ).length,
      completedSubordinateResults: head.state.results
        .filter((result) => {
          const producer = head.state.calls.find(
            (candidate) => candidate.callId === result.producerCallId,
          );
          return producer?.parentCallId === call.callId;
        })
        .map(({ resultRef, roleId, outcome, summary }) => ({
          resultRef,
          roleId,
          outcome,
          summary,
        })),
      ...(immediateReconsideration
        ? {
            capabilitySelectionReconsideration: immediateReconsideration,
          }
        : {}),
      ...(operationSupervision.length > 0 ? { operationSupervision } : {}),
      omissionSemantics: {
        capabilityResults:
          "Accepted capability actions and exact canonical adapter results are supplied only in the chronological native tool lane after the current request.",
        subordinateResults:
          "A listed subordinate result is passive evidence and never selects the next action.",
        ...(projection.includeCapabilitySelectionReconsideration
          ? {
              capabilitySelectionReconsideration:
                "When present, it records only that controls refinement for the exact prior selection exhausted structured-output validation before execution. Its optional supervision field is passive mechanical repetition metadata, not a semantic judgment or requirement to execute; the receipt selects no replacement and establishes no result.",
            }
          : {}),
        ...(projection.includeOperationSupervision
          ? {
              operationSupervision:
                "When present, it reports bounded mechanical repetition notices created for this activation only. A notice is neither user intent nor a capability result and does not select the next action.",
            }
          : {}),
      },
    }),
  });
}

export function buildExecutionCapabilityGroupCatalogMessage(
  catalogGroups: readonly CapabilityCatalogGroup[],
): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: EXECUTION_CAPABILITY_GROUP_CATALOG_MESSAGE_KIND,
      authority: "runtime_registry",
      presenceEffect: "passive_routing_metadata_not_user_intent",
      scopeSemantics: {
        groupCombination: "or_union",
        openAction: "establish_when_closed",
        extendAction: "add_only_inactive_groups_when_active",
        unchangedUpdate: "rejected_before_action",
        automaticTransitions: false,
      },
      groupDescriptionProjection: {
        source: "all_group_member_capabilities",
        lineFormat: "capabilityId: summary",
        ordering: "ascii_ascending",
        completeness: "all_members_without_sampling_or_truncation",
      },
      catalogGroups,
    }),
  });
}

export function buildExecutionCapabilityCatalogMessage(
  capabilities: readonly CapabilityDescriptor[],
): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: EXECUTION_CAPABILITY_CATALOG_MESSAGE_KIND,
      authority: "runtime_registry",
      capabilities: capabilities.map((capability) => ({
        capabilityId: capability.capabilityId,
        summary: capability.summary,
        effect: capability.effect,
        selectionControlIds: capability.selectionControlIds ?? [],
      })),
    }),
  });
}

/**
 * Reconstructs accepted invocations and settled results without semantic
 * interpretation. Each batch becomes one assistant call group followed by its
 * linked tool results in ledger order.
 */
export function buildExecutionContinuationMessages(
  head: RoleCallLedgerHead,
  call: RoleCallFrame = requireActiveRootCall(head),
  memoryRecalls: readonly MemoryRecallContinuation[] = [],
): readonly ChatMessage[] {
  assertExecutionRoot(head, call);
  const executions = head.state.capabilityExecutions.filter(
    (execution) => execution.callId === call.callId,
  );
  if (executions.some((execution) => execution.status !== "settled")) {
    throw new Error("execution_agent_continuation_unsettled");
  }
  const groups: RoleCapabilityExecution[][] = [];
  for (const execution of executions) {
    const current = groups.at(-1);
    if (current?.[0]?.invocationAttempt === execution.invocationAttempt) {
      current.push(execution);
    } else {
      groups.push([execution]);
    }
  }
  const continuations = [
    ...groups.map((group) => ({
      invocationAttempt: group[0]!.invocationAttempt,
      messages: [
        buildAcceptedActionMessage(group),
        ...group.map((execution) => buildCapabilityResultMessage(execution)),
      ],
    })),
    ...memoryRecalls,
  ];
  continuations.sort(
    (left, right) => left.invocationAttempt - right.invocationAttempt,
  );
  return Object.freeze(continuations.flatMap(({ messages }) => messages));
}

function buildAcceptedActionMessage(
  executions: readonly RoleCapabilityExecution[],
): ChatMessage {
  const invocationAttempt = executions[0]!.invocationAttempt;
  const action =
    executions.length === 1 ? "invoke_capability" : "invoke_capabilities";
  return Object.freeze({
    role: "assistant" as const,
    content: "",
    toolCalls: Object.freeze(
      executions.map((execution, invocationIndex) =>
        Object.freeze({
          callId: execution.executionId,
          name: EXECUTION_CAPABILITY_TOOL_NAME,
          arguments: JSON.stringify({
            kind: EXECUTION_AGENT_ACTION_MESSAGE_KIND,
            authority: "accepted_execution_agent_action",
            invocationAttempt,
            invocationIndex,
            invocationCount: executions.length,
            action,
            invocation: {
              executionId: execution.executionId,
              capabilityId: execution.capabilityId,
              controls: readAcceptedControls(execution),
              declaredEffect: execution.declaredEffect,
            },
          }),
        }),
      ),
    ),
  });
}

function buildCapabilityResultMessage(
  execution: RoleCapabilityExecution,
): ChatMessage {
  if (execution.status !== "settled" || execution.exactResult === undefined) {
    throw new Error("execution_agent_continuation_result_invalid");
  }
  return Object.freeze({
    role: "tool" as const,
    content: JSON.stringify({
      kind: EXECUTION_CAPABILITY_RESULT_MESSAGE_KIND,
      authority: "capability_adapter_result",
      presenceEffect: "runtime_result_only_not_user_intent",
      invocationAttempt: execution.invocationAttempt,
      result: {
        executionId: execution.executionId,
        capabilityId: execution.capabilityId,
        adapterResult: execution.exactResult,
      },
    }),
    toolCallId: execution.executionId,
    toolName: EXECUTION_CAPABILITY_TOOL_NAME,
  });
}

function readAcceptedControls(
  execution: RoleCapabilityExecution,
): Readonly<Record<string, unknown>> {
  const controlsJson = (
    execution as RoleCapabilityExecution & { controlsJson?: unknown }
  ).controlsJson;
  if (typeof controlsJson !== "string") {
    throw new Error("execution_agent_continuation_controls_missing");
  }
  const decoded = JSON.parse(controlsJson) as unknown;
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw new Error("execution_agent_continuation_controls_invalid");
  }
  return decoded as Readonly<Record<string, unknown>>;
}

function requireActiveRootCall(head: RoleCallLedgerHead): RoleCallFrame {
  const call = head.state.calls.find(
    (candidate) => candidate.callId === head.state.rootCallId,
  );
  if (!call) throw new Error("execution_agent_root_call_missing");
  return call;
}

function assertExecutionRoot(
  head: RoleCallLedgerHead,
  call: RoleCallFrame,
): void {
  if (
    head.state.phase !== "running" ||
    call.callId !== head.state.rootCallId ||
    call.callId !== head.state.activeCallId ||
    call.parentCallId !== null ||
    call.status !== "active"
  ) {
    throw new Error("execution_agent_state_not_runnable");
  }
}
