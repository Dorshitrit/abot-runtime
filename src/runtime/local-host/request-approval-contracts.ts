import type { SchedulerRun } from "../scheduler/contracts.js";
import type { ToolApprovalRequest } from "../ports.js";

/** Safe approval projection. Durable waits contain identity, never executable data. */
export type LocalPendingToolApproval = Readonly<{
  sessionId: string;
  run?: SchedulerRun;
  request: ToolApprovalRequest;
  wait?: Readonly<{ generation: string; waitId: string; revision: number }>;
}>;

export type LocalToolApprovalDecisionInput = Readonly<{
  sessionId: string;
  requestId: string;
  approvalId: string;
  approved: boolean;
  reason?: string;
  generation?: string;
  waitId?: string;
  revision?: number;
  commandId?: string;
}>;

export type LocalToolApprovalDecisionResult =
  | Readonly<{ accepted: true; duplicate?: boolean }>
  | Readonly<{
      accepted: false;
      reason:
        | "approval_not_pending"
        | "approval_identity_mismatch"
        | "approval_request_not_attached"
        | "approval_resume_unavailable"
        | "approval_conflict"
        | "invalid_approval_decision";
    }>;
