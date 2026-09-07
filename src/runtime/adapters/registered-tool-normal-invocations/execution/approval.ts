import type { ToolCall } from "../../../../capabilities/tool-types.js";
import {
  buildToolExecutorEventMetadata,
  type ToolEventExecutorIdentity,
} from "../shared/event-metadata.js";
import type {
  ToolApprovalController,
  ToolPermissionMode,
} from "../../../ports.js";
import type { RegisteredToolNormalInvocationRejection } from "../shared/contracts.js";
import { rejectNormalInvocation } from "../shared/rejection.js";

export async function requestNormalInvocationApproval(params: {
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
  if (!params.force && params.toolPermissionMode !== "ask") {
    return Object.freeze({ ok: true as const });
  }
  const approvalId = params.nextApprovalId();
  params.onEvent?.("tool.approval.required", {
    ...buildToolExecutorEventMetadata(params.executorIdentity),
    ...(params.executionId ? { executionId: params.executionId } : {}),
    approvalId,
    tool: params.call.tool,
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
      requestId: params.requestId,
      approvalId,
      call: params.call,
      ...(params.eventMeta ? { meta: params.eventMeta } : {}),
    },
    { abortSignal: params.abortSignal },
  );
  if (decision.approved) {
    params.onEvent?.("tool.approval.granted", {
      ...buildToolExecutorEventMetadata(params.executorIdentity),
      ...(params.executionId ? { executionId: params.executionId } : {}),
      approvalId,
      tool: params.call.tool,
    });
    return Object.freeze({ ok: true as const });
  }
  const message = decision.reason?.trim() || "Tool execution was rejected.";
  params.onEvent?.("tool.approval.rejected", {
    ...buildToolExecutorEventMetadata(params.executorIdentity),
    ...(params.executionId ? { executionId: params.executionId } : {}),
    approvalId,
    tool: params.call.tool,
    reason: message,
  });
  return {
    ok: false,
    rejection: rejectNormalInvocation("tool_approval_rejected", message),
  };
}
