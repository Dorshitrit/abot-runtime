import { requiresToolActionApproval } from "../../../../capabilities/tool-permission-mode.js";
import type { ToolCall } from "../../../../capabilities/tool-types.js";
import {
  buildToolExecutorEventMetadata,
  type ToolEventExecutorIdentity,
} from "../shared/event-metadata.js";
import type {
  ToolApprovalController,
  ToolApprovalRequest,
  ToolApprovalDecision,
  ToolPermissionMode,
} from "../../../ports.js";
import type { RegisteredToolNormalInvocationRejection } from "../shared/contracts.js";
import { rejectNormalInvocation } from "../shared/rejection.js";

function recommendsFullPlusForForcedAction(
  mode: ToolPermissionMode,
  force: boolean,
): boolean {
  if (mode !== "full_access") return false;
  return force;
}

export async function requestNormalInvocationApproval(params: {
  preparedRequest?: ToolApprovalRequest;
  decision?: ToolApprovalDecision;
  decisionRecorded?: boolean;
  executionId?: string;
  executorIdentity?: ToolEventExecutorIdentity;
  requestId: string;
  abortSignal: AbortSignal;
  toolPermissionMode: ToolPermissionMode;
  toolApprovalController?: ToolApprovalController;
  nextApprovalId(): string;
  onEvent?(name: string, payload: Record<string, unknown>): void;
  call: ToolCall;
  eventMeta?: Record<string, unknown>;
  force: boolean;
}): Promise<
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; rejection: RegisteredToolNormalInvocationRejection }>
> {
  if (!requiresToolActionApproval(params.toolPermissionMode, params.force)) {
    return Object.freeze({ ok: true as const });
  }
  const approvalId =
    params.preparedRequest?.approvalId ?? params.nextApprovalId();
  if (params.decision)
    return applyDecision(params, approvalId, params.decision);

  params.onEvent?.("tool.approval.required", {
    ...buildToolExecutorEventMetadata(params.executorIdentity),
    ...(params.executionId ? { executionId: params.executionId } : {}),
    approvalId,
    tool: params.call.tool,
    ...(recommendsFullPlusForForcedAction(
      params.toolPermissionMode,
      params.force,
    )
      ? { recommendedToolPermissionMode: "full_plus" }
      : {}),
    ...(params.eventMeta ? { meta: params.eventMeta } : {}),
  });
  if (!params.toolApprovalController) {
    const message =
      "Tool approval is required, but no approval controller is configured.";
    params.onEvent?.("tool.approval.rejected", {
      ...buildToolExecutorEventMetadata(params.executorIdentity),
      ...(params.executionId ? { executionId: params.executionId } : {}),
      approvalId,
      tool: params.call.tool,
      reason: message,
    });
    return {
      ok: false,
      rejection: rejectNormalInvocation("tool_approval_unavailable", message),
    };
  }
  const decision = await params.toolApprovalController.requestToolApproval(
    {
      ...(params.preparedRequest ?? {
        requestId: params.requestId,
        approvalId,
        call: params.call,
        ...(params.eventMeta ? { meta: params.eventMeta } : {}),
      }),
    },
    { abortSignal: params.abortSignal },
  );
  return applyDecision(params, approvalId, decision);
}

function applyDecision(
  params: Parameters<typeof requestNormalInvocationApproval>[0],
  approvalId: string,
  decision: ToolApprovalDecision,
) {
  if (decision.approved) {
    if (!params.decisionRecorded)
      params.onEvent?.("tool.approval.granted", {
        ...buildToolExecutorEventMetadata(params.executorIdentity),
        ...(params.executionId ? { executionId: params.executionId } : {}),
        approvalId,
        tool: params.call.tool,
      });
    return Object.freeze({ ok: true as const });
  }
  const message = decision.reason?.trim() || "Tool execution was rejected.";
  if (!params.decisionRecorded)
    params.onEvent?.("tool.approval.rejected", {
      ...buildToolExecutorEventMetadata(params.executorIdentity),
      ...(params.executionId ? { executionId: params.executionId } : {}),
      approvalId,
      tool: params.call.tool,
      reason: message,
    });
  return {
    ok: false as const,
    rejection: rejectNormalInvocation("tool_approval_rejected", message),
  };
}
