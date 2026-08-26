import type { ChatMessage } from "../../../model-gateway/types.js";
import type {
  RoleCallFrame,
  RoleCallLedgerHead,
  RoleCapabilityExecution,
} from "../../orchestration/role-calls/index.js";
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
export const EXECUTION_CAPABILITY_RECONSIDERATION_MESSAGE_KIND =
  "runtime_execution_capability_reconsideration_v1" as const;
export const EXECUTION_CAPABILITY_TOOL_NAME = "runtime_capability" as const;

export function buildExecutionStateMessage(
  head: RoleCallLedgerHead,
  call: RoleCallFrame = requireActiveRootCall(head),
): ChatMessage {
  assertExecutionRoot(head, call);
  const reconsideration = call.lastCapabilitySelectionReconsideration;
  const immediateReconsideration =
    reconsideration &&
    call.activationCount === reconsideration.invocationAttempt + 1
      ? reconsideration
      : undefined;
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
            capabilitySelectionReconsideration: {
              kind: EXECUTION_CAPABILITY_RECONSIDERATION_MESSAGE_KIND,
              authority: "canonical_role_call_ledger",
              presenceEffect: "passive_continuity_not_next_action",
              outcome: "reconsidered_before_execution",
              executionOccurred: false,
              invocationAttempt: immediateReconsideration.invocationAttempt,
              steeringVersion: immediateReconsideration.steeringVersion,
              fingerprint: immediateReconsideration.fingerprint,
              selection: {
                ...immediateReconsideration.selection,
                invocations: immediateReconsideration.selection.invocations.map(
                  (invocation) => ({
                    capabilityId: invocation.capabilityId,
                    selectionControls: JSON.parse(
                      invocation.selectionControlsJson,
                    ) as unknown,
                  }),
                ),
              },
            },
          }
        : {}),
      omissionSemantics: {
        capabilityResults:
          "Accepted capability actions and exact canonical adapter results are supplied only in the chronological native tool lane after the current request.",
        subordinateResults:
          "A listed subordinate result is passive evidence and never selects the next action.",
        capabilitySelectionReconsideration:
          "When present, it records only that the exact prior selection was reconsidered before execution; it neither selects a replacement nor establishes any result.",
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
  return Object.freeze(
    groups.flatMap((group) => [
      buildAcceptedActionMessage(group),
      ...group.map((execution) => buildCapabilityResultMessage(execution)),
    ]),
  );
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
