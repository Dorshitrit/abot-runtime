import type { LocalToolApprovalDecisionInput } from "../runtime/local-host/request-approval-contracts.js";
import type WebSocket from "ws";

export const REQUEST_APPROVALS_FEATURE = "request_approvals_v1" as const;
export const DURABLE_APPROVAL_MODE = "durable_v1" as const;

export type BridgeApprovalScope = Readonly<{
  correlationId: string;
  sessionId: string;
  requestId: string;
}>;

export function readApprovalScope(
  message: Record<string, unknown>,
): BridgeApprovalScope | undefined {
  if (!isApprovalIdentifier(message.correlationId)) return undefined;
  if (!isApprovalIdentifier(message.sessionId)) return undefined;
  if (!isApprovalIdentifier(message.requestId)) return undefined;
  return {
    correlationId: message.correlationId,
    sessionId: message.sessionId,
    requestId: message.requestId,
  };
}

export function isApprovalIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function readApprovalDecision(
  message: Record<string, unknown>,
  scope: BridgeApprovalScope,
): LocalToolApprovalDecisionInput | undefined {
  if (!isApprovalIdentifier(message.approvalId)) return undefined;
  if (typeof message.approved !== "boolean") return undefined;
  if (message.reason !== undefined && typeof message.reason !== "string")
    return undefined;
  const hasWaitIdentity = [
    "generation",
    "waitId",
    "revision",
    "commandId",
  ].some((key) => message[key] !== undefined);
  if (hasWaitIdentity && !hasCompleteWaitIdentity(message)) return undefined;
  return {
    sessionId: scope.sessionId,
    requestId: scope.requestId,
    approvalId: message.approvalId,
    approved: message.approved,
    ...(message.reason !== undefined ? { reason: message.reason } : {}),
    ...(hasWaitIdentity
      ? {
          generation: message.generation as string,
          waitId: message.waitId as string,
          revision: message.revision as number,
          commandId: message.commandId as string,
        }
      : {}),
  };
}

function hasCompleteWaitIdentity(message: Record<string, unknown>): boolean {
  if (!isApprovalIdentifier(message.generation)) return false;
  if (!isApprovalIdentifier(message.waitId)) return false;
  if (!Number.isSafeInteger(message.revision)) return false;
  if ((message.revision as number) < 0) return false;
  return isApprovalIdentifier(message.commandId);
}

export function approvalResponseIdentity(message: Record<string, unknown>) {
  return {
    correlationId:
      typeof message.correlationId === "string" ? message.correlationId : "",
    sessionId: typeof message.sessionId === "string" ? message.sessionId : "",
    requestId: typeof message.requestId === "string" ? message.requestId : "",
  };
}

/** New peers negotiate explicitly; old relay messages retain their original path. */
export function refuseUnsupportedApprovalMessage(
  socket: WebSocket,
  message: Record<string, unknown>,
  available: boolean,
): boolean {
  if (message.type === "run_request" && message.approvalMode !== undefined) {
    const error = runApprovalModeError(message, available);
    if (!error) return false;
    socket.send(
      JSON.stringify({
        type: "failed",
        requestId: message.requestId,
        sessionId: message.sessionId,
        error,
      }),
    );
    return true;
  }
  if (available) return false;
  const responses: Record<string, string> = {
    "request.approvals.request": "request.approvals.response",
    "request.approval.decide.request": "request.approval.decide.response",
  };
  const type =
    typeof message.type === "string" ? responses[message.type] : undefined;
  if (!type) return false;
  socket.send(
    JSON.stringify({
      type,
      ...approvalResponseIdentity(message),
      ok: false,
      error: "approval_access_unavailable",
    }),
  );
  return true;
}

function runApprovalModeError(
  message: Record<string, unknown>,
  available: boolean,
): string | undefined {
  if (message.approvalMode !== DURABLE_APPROVAL_MODE)
    return "approval_mode_unsupported";
  if (!available) return "durable_approvals_unavailable";
  if (message.command !== undefined) return "approval_mode_unsupported";
  if (!isApprovalIdentifier(message.sessionId)) return "invalid_approval_scope";
  if (!isApprovalIdentifier(message.requestId)) return "invalid_approval_scope";
  return undefined;
}
