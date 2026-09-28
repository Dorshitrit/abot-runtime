import type { SessionRequestStatus } from "../types.js";

export type SessionBlobReference = Readonly<{
  sha256: string;
  byteLength: number;
}>;
export type SessionContinuationReference = Readonly<{
  schema: string;
  version: number;
  blob: SessionBlobReference;
}>;

export type SessionActivation = Readonly<{
  activationId: string;
  ownerEpoch: string;
}>;
export type SessionActivationExpectation = SessionActivation &
  Readonly<{
    requestId: string;
    generation: string;
    revision: number;
  }>;
export type SessionWaitExpectation = Readonly<{
  requestId: string;
  generation: string;
  waitId: string;
  revision: number;
}>;

/** Disclosure only. Executable actions belong to the opaque continuation. */
export type SessionApprovalDescription = Readonly<{
  approvalId: string;
  actionFingerprint: string;
  presentation: Readonly<Record<string, unknown>>;
}>;
export type SessionApprovalDecisionReceipt = Readonly<{
  commandId: string;
  requestId: string;
  generation: string;
  waitId: string;
  approvalId: string;
  approved: boolean;
  reason?: string;
  committedAt: string;
  revision: number;
  activation?: SessionActivation;
}>;
export type SessionApprovalPresentation = Readonly<{
  kind: "tool_approval_request";
  waitId: string;
  state: "pending" | "consumed" | "cancelled";
  approvals: readonly SessionApprovalDescription[];
  decisions: readonly SessionApprovalDecisionReceipt[];
}>;
export type SessionApprovalWait = Readonly<{
  waitId: string;
  createdAt: string;
  presentationMessageId: string;
  approvals: readonly SessionApprovalDescription[];
  continuation: SessionContinuationReference;
}>;
export type SessionRequestTerminalCause =
  | "request_cancelled"
  | "request_interrupted"
  | "request_failed";

/** Stored within SessionRequestRecord; request.status is the sole phase authority. */
export type SessionRequestLifecycleRecord = {
  schemaVersion: 1;
  revision: number;
  activation: SessionActivation;
  wait?: SessionApprovalWait;
  decisionReceipts: SessionApprovalDecisionReceipt[];
  terminalCause?: SessionRequestTerminalCause;
  terminalCommandId?: string;
};

/** Client-safe projection: deliberately excludes continuation references and bytes. */
export type SessionRequestLifecycleSnapshot = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  requestId: string;
  generation: string;
  status: SessionRequestStatus;
  revision: number;
  activation?: SessionActivation;
  wait?: Omit<SessionApprovalWait, "continuation">;
  decisionReceipts: readonly SessionApprovalDecisionReceipt[];
  terminalCause?: SessionRequestTerminalCause;
}>;

export type SessionLifecycleRejectionReason =
  | "session_missing"
  | "request_missing"
  | "lifecycle_missing"
  | "generation_mismatch"
  | "revision_mismatch"
  | "activation_mismatch"
  | "request_not_running"
  | "request_not_waiting"
  | "request_already_started"
  | "wait_mismatch"
  | "approval_missing"
  | "approval_already_decided"
  | "decision_command_conflict"
  | "resume_activation_required"
  | "invalid_command";

export type SessionLifecycleMutationResult =
  | Readonly<{
      accepted: true;
      current: SessionRequestLifecycleSnapshot;
      events: readonly Record<string, unknown>[];
      receipt?: SessionApprovalDecisionReceipt;
      duplicate?: boolean;
    }>
  | Readonly<{
      accepted: false;
      reason: SessionLifecycleRejectionReason;
      current?: SessionRequestLifecycleSnapshot;
    }>;

export type SessionStartActivationCommand = SessionActivation &
  Readonly<{
    requestId: string;
    /** Required when adopting a stream already initialized by the request handler. */
    expectedGeneration?: string;
  }>;
export type SessionCommitWaitCommand = Readonly<{
  expected: SessionActivationExpectation;
  waitId: string;
  approvals: readonly SessionApprovalDescription[];
  continuation: SessionContinuationReference;
  presentationText: string;
  initialDecisions?: readonly Readonly<{
    approvalId: string;
    approved: boolean;
    reason?: string;
    commandId: string;
  }>[];
}>;
export type SessionCommitDecisionCommand = Readonly<{
  expected: SessionWaitExpectation;
  commandId: string;
  approvalId: string;
  approved: boolean;
  reason?: string;
  /** Supplied only after the caller's retirement and hydration preflight. */
  resumeActivation?: SessionActivation;
}>;
export type SessionTerminalMessage = Readonly<{
  content: string;
  thinkingTrace?: import("../types.js").SessionThinkingTraceEntry[];
}> &
  Readonly<
    Pick<
      import("../types.js").SessionMessage,
      | "grounding"
      | "observationMeta"
      | "observationContent"
      | "attachments"
      | "taskType"
    >
  > &
  Readonly<{ lastAgentMode?: import("../../shared/types.js").AgentMode }>;
export type SessionCancelWaitCommand = Readonly<{
  expected: SessionWaitExpectation;
  commandId: string;
  message: SessionTerminalMessage;
}>;
export type SessionCommitTerminalCommand = Readonly<{
  expected: SessionActivationExpectation;
  commandId: string;
  status: "completed" | "failed";
  cause?: SessionRequestTerminalCause;
  message: SessionTerminalMessage;
  error?: string;
}>;
export type SessionInterruptActivationCommand = Readonly<{
  expected: SessionActivationExpectation;
  commandId: string;
  message: SessionTerminalMessage;
}>;

export interface SessionRequestLifecycleStore {
  startActivation(
    sessionId: string,
    command: SessionStartActivationCommand,
  ): Promise<SessionLifecycleMutationResult>;
  commitWait(
    sessionId: string,
    command: SessionCommitWaitCommand,
  ): Promise<SessionLifecycleMutationResult>;
  commitDecision(
    sessionId: string,
    command: SessionCommitDecisionCommand,
  ): Promise<SessionLifecycleMutationResult>;
  cancelWait(
    sessionId: string,
    command: SessionCancelWaitCommand,
  ): Promise<SessionLifecycleMutationResult>;
  interruptActivation(
    sessionId: string,
    command: SessionInterruptActivationCommand,
  ): Promise<SessionLifecycleMutationResult>;
  commitTerminal(
    sessionId: string,
    command: SessionCommitTerminalCommand,
  ): Promise<SessionLifecycleMutationResult>;
  appendActivationEvent(
    sessionId: string,
    command: Readonly<{
      expected: SessionActivationExpectation;
      payload: Record<string, unknown>;
    }>,
  ): Promise<SessionLifecycleMutationResult>;
  get(
    sessionId: string,
    requestId: string,
  ): Promise<SessionRequestLifecycleSnapshot | null>;
  listWaiting(
    sessionId?: string,
  ): Promise<readonly SessionRequestLifecycleSnapshot[]>;
  getDecisionReceipt(
    sessionId: string,
    requestId: string,
    generation: string,
    commandId: string,
  ): Promise<SessionApprovalDecisionReceipt | null>;
  /** Trusted runtime reads only: no Web list/snapshot response may expose this reference. */
  getContinuation(
    sessionId: string,
    expected: SessionWaitExpectation,
  ): Promise<SessionContinuationReference | null>;
  writeContinuation(
    sessionId: string,
    input: Readonly<{ schema: string; version: number; value: unknown }>,
  ): Promise<SessionContinuationReference>;
  readContinuation(
    sessionId: string,
    reference: SessionContinuationReference,
  ): Promise<unknown>;
  writeBlob(
    sessionId: string,
    bytes: Uint8Array,
  ): Promise<SessionBlobReference>;
  readBlob(
    sessionId: string,
    reference: SessionBlobReference,
  ): Promise<Uint8Array>;
}
