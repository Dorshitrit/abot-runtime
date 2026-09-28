import type { ToolApprovalDecision, ToolApprovalRequest } from "../../ports.js";
import type { RoleCapabilityDeclaredEffect } from "../role-calls/index.js";
import type {
  WorkerCapabilityControls,
  WorkerCapabilityExecutionFreshness,
} from "./contracts.js";

/** Data only. The producing adapter owns validation and hydration of snapshot. */
export type PreparedApprovalGroupEntry = Readonly<{
  executionId: string;
  capabilityId: string;
  declaredEffect: RoleCapabilityDeclaredEffect;
  intent: string;
  authoringObjective?: string;
  controls: WorkerCapabilityControls;
  actionFingerprint: string;
  snapshot: unknown;
  approvalRequest?: ToolApprovalRequest;
}>;

/** One already admitted group, parked before any member is dispatched. */
export type PreparedApprovalGroup = Readonly<{
  kind: "prepared_approval_group_v1";
  requestId: string;
  callId: string;
  invocationAttempt: number;
  batch: boolean;
  initialDecisions?: readonly BoundApprovalDecision[];
  entries: readonly PreparedApprovalGroupEntry[];
  executionFreshnessToken?: WorkerCapabilityExecutionFreshness["token"];
}>;

export type BoundApprovalDecision = Readonly<{
  approvalId: string;
  actionFingerprint: string;
  decision: ToolApprovalDecision;
  recorded?: boolean;
}>;

export type WorkerCapabilityApprovalWait = Readonly<{
  kind: "awaiting_approval";
  group: PreparedApprovalGroup;
}>;

/** The request owner decides whether work is quiescent or must keep waiting live. */
export type CapabilityApprovalGate = Readonly<{
  resolve(
    group: PreparedApprovalGroup,
  ): Promise<
    | Readonly<{
        kind: "awaiting_approval";
        decisions?: readonly BoundApprovalDecision[];
      }>
    | Readonly<{
        kind: "decisions";
        decisions: readonly BoundApprovalDecision[];
      }>
  >;
}>;

export function isWorkerCapabilityApprovalWait(
  value: unknown,
): value is WorkerCapabilityApprovalWait {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "awaiting_approval"
  );
}
