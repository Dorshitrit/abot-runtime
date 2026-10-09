import type WebSocket from "ws";
import type { LocalPendingToolApproval } from "../../runtime/local-host/request-approval-contracts.js";
import { createRequestSteeringInbox } from "../../runtime/request/request-steering.js";
import type {
  ActiveRequest,
  JsonObject,
  RuntimeEnvironment,
} from "./contracts.js";
import type { PendingToolApprovals } from "./pending-tool-approvals.js";
import { traceWebProjection } from "./request-control-observation.js";

type ApprovalAttachmentInput = {
  environmentId: string;
  environment: RuntimeEnvironment;
  pending: LocalPendingToolApproval;
  events: readonly JsonObject[];
  activeRequests: Map<string, ActiveRequest>;
  toolApprovals: PendingToolApprovals;
  publish(data: string): void;
};

function hasMatchingRequestView(
  active: ActiveRequest,
  input: ApprovalAttachmentInput,
): boolean {
  if (active.environmentId !== input.environmentId) return false;
  return active.sessionId === input.pending.sessionId;
}

/** Restore only a projection of an owner-confirmed pending request, never a new run. */
export async function attachApprovalRequest(
  input: ApprovalAttachmentInput,
): Promise<void> {
  const { pending, environmentId, environment, activeRequests } = input;
  const requestId = pending.request.requestId;
  let active = activeRequests.get(requestId);
  const createdProjection = !active;
  if (active && !hasMatchingRequestView(active, input))
    throw new Error("tool_approval_request_identity_mismatch");
  if (!active) {
    active = {
      requestId,
      sessionId: pending.sessionId,
      environmentId,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      lastEventName: "tool.approval.required",
      events: [...input.events],
      finalState: null,
      requestSteering: createRequestSteeringInbox({
        requestId,
        diagnostics: { origin: "web_projection" },
      }),
    };
    activeRequests.set(requestId, active);
    traceWebProjection(
      "projection.opened",
      requestId,
      active,
      "approval_attachment",
    );
  }
  if (pending.run) return;
  const projection = active;
  await new Promise<void>((resolve, reject) => {
    let accepted = false;
    void environment.approvals
      .attach(
        requestId,
        pending.sessionId,
        { send: input.publish } as WebSocket,
        { toolApprovalController: input.toolApprovals },
        () => {
          accepted = true;
          resolve();
        },
      )
      .catch((error: unknown) => {
        if (createdProjection && activeRequests.get(requestId) === projection) {
          const removed = activeRequests.delete(requestId);
          traceWebProjection(
            "projection.removed",
            requestId,
            projection,
            "attachment_error",
            removed,
          );
        }
        if (accepted)
          input.publish(
            JSON.stringify({
              type: "control",
              requestId,
              name: "local_runtime_approval_attachment_lost",
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        reject(error);
      })
      .finally(() => {
        if (!projection.finalState) return;
        if (activeRequests.get(requestId) === projection) {
          const removed = activeRequests.delete(requestId);
          traceWebProjection(
            "projection.removed",
            requestId,
            projection,
            "attachment_terminal_settled",
            removed,
          );
        }
      });
  });
}
