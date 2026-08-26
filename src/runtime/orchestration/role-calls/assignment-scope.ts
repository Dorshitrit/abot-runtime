import type { ChatMessage } from "../../../model-gateway/types.js";
import type { ModelStep } from "../../../shared/model-steps.js";
import { traceDebug } from "../../observability/debug-logger.js";
import type { RuntimeRoleId } from "../roles.js";
import type { RoleCallFrame, RoleCallLedgerHead } from "./contracts.js";

export const ROLE_CALL_ASSIGNMENT_SCOPE_MESSAGE_KIND =
  "runtime_role_call_assignment_scope_v1" as const;

const ROLE_CALL_ASSIGNMENT_SCOPE_LOG_SCOPE = "runtime.role_assignment_scope";

export type RoleCallAssignmentScopeView = Readonly<{
  sourceRevision: number;
  scopeCallId: string;
  scopeRoleId: RuntimeRoleId;
  scopeObjective: string;
}>;

/**
 * Projects the highest non-root assignment that owns the active call.
 * This transports canonical ledger data without interpreting its domain,
 * extracting paths, or choosing any runtime action.
 */
export function projectRoleCallAssignmentScope(params: Readonly<{
  head: RoleCallLedgerHead;
  call: RoleCallFrame;
  modelStep: ModelStep;
}>): RoleCallAssignmentScopeView | undefined {
  try {
    const canonicalCall = params.head.state.calls.find(
      ({ callId }) => callId === params.call.callId,
    );
    if (
      params.head.state.phase !== "running" ||
      params.head.state.activeCallId !== params.call.callId ||
      canonicalCall !== params.call ||
      canonicalCall.status !== "active"
    ) {
      throw new Error("role_assignment_scope_authority_invalid");
    }

    const scope = findHighestDelegatedCall(params.head, canonicalCall);
    if (scope.callId === canonicalCall.callId) {
      traceProjection(params, undefined);
      return undefined;
    }
    if (!scope.objective) {
      throw new Error("role_assignment_scope_objective_missing");
    }

    const view = Object.freeze({
      sourceRevision: params.head.revision,
      scopeCallId: scope.callId,
      scopeRoleId: scope.roleId,
      scopeObjective: scope.objective,
    });
    traceProjection(params, view);
    return view;
  } catch (error: unknown) {
    traceDebug(ROLE_CALL_ASSIGNMENT_SCOPE_LOG_SCOPE, "rejected", {
      requestId: params.head.state.requestId,
      modelStep: params.modelStep,
      callId: params.call.callId,
      sourceRevision: params.head.revision,
      issueCode:
        error instanceof Error &&
        error.message.startsWith("role_assignment_scope_")
          ? error.message
          : "role_assignment_scope_projection_failed",
    });
    throw error;
  }
}

export function buildRoleCallAssignmentScopeMessage(
  view: RoleCallAssignmentScopeView,
): ChatMessage {
  return Object.freeze({
    role: "user" as const,
    content: JSON.stringify({
      kind: ROLE_CALL_ASSIGNMENT_SCOPE_MESSAGE_KIND,
      authority: "reference_data",
      sourceRevision: view.sourceRevision,
      scopeCallId: view.scopeCallId,
      scopeRoleId: view.scopeRoleId,
      scopeObjective: view.scopeObjective,
    }),
  });
}

function findHighestDelegatedCall(
  head: RoleCallLedgerHead,
  activeCall: RoleCallFrame,
): RoleCallFrame {
  const rootCallId = head.state.rootCallId;
  if (!rootCallId) {
    throw new Error("role_assignment_scope_root_missing");
  }

  let scope = activeCall;
  const visited = new Set<string>();
  while (scope.parentCallId !== null && scope.parentCallId !== rootCallId) {
    if (visited.has(scope.callId)) {
      throw new Error("role_assignment_scope_ancestry_invalid");
    }
    visited.add(scope.callId);
    const parent = head.state.calls.find(
      ({ callId }) => callId === scope.parentCallId,
    );
    if (!parent || parent.depth !== scope.depth - 1) {
      throw new Error("role_assignment_scope_ancestry_invalid");
    }
    scope = parent;
  }
  if (scope.parentCallId !== rootCallId) {
    throw new Error("role_assignment_scope_ancestry_invalid");
  }
  return scope;
}

function traceProjection(
  params: Readonly<{
    head: RoleCallLedgerHead;
    call: RoleCallFrame;
    modelStep: ModelStep;
  }>,
  view: RoleCallAssignmentScopeView | undefined,
): void {
  traceDebug(ROLE_CALL_ASSIGNMENT_SCOPE_LOG_SCOPE, "projected", {
    requestId: params.head.state.requestId,
    modelStep: params.modelStep,
    callId: params.call.callId,
    sourceRevision: params.head.revision,
    assignmentScopeIncluded: view !== undefined,
    ...(view
      ? {
          scopeCallId: view.scopeCallId,
          scopeRoleId: view.scopeRoleId,
          scopeObjectiveLength: view.scopeObjective.length,
        }
      : {}),
  });
}
