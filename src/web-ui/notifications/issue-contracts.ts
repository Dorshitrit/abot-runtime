import type { SessionKind } from "../../sessions/spark-session.js";

/** UI-only diagnostic data. Sources must supply an immutable internal occurrence identity/time. */
export type NotificationIssueOutcome = "recovered" | "failed" | "interrupted";
export type NotificationIssueAction =
  | { kind: "model-settings"; profileId: string }
  | { kind: "step-timeout"; reference: {
      environment: string; sessionId: string; requestId: string; invocationId: string;
    } };
export type NotificationIssue = {
  groupKey: string;
  occurrenceCount: number;
  firstOccurredAt: number;
  lastOccurredAt: number;
  outcomeCounts: Record<NotificationIssueOutcome, number>;
  /** Monotonic store sequence, used for snapshot-bound mark-all-read. */
  lastSequence: number;
  action?: NotificationIssueAction;
};
export type NotificationIssueOccurrence = {
  environmentId: string;
  namespace: string;
  occurrenceId: string;
  occurredAt: number;
  outcome: NotificationIssueOutcome;
  grouping: {
    source: string;
    provider?: string;
    profile?: string;
    cause: string;
    remediationTarget: string;
    configuration?: Record<string, string | number | boolean | null>;
  };
  title: string;
  body: string;
  source?: { sessionId: string; requestId?: string; sessionKind?: SessionKind };
  action?: NotificationIssueAction;
};
export type NotificationIssueReadState = {
  id: string; occurrenceCount: number; readAt: number | null; issue: NotificationIssue;
  title: string; body: string; sourceUrl: string; sessionId?: string; requestId?: string; sessionKind?: SessionKind;
};
export type NotificationIssueCoverage = {
  receiptLimit: number;
  retentionMs: number;
  rejectedCount: number;
  /** Process-local losses before persistence when the live collection queue is full. */
  collectionRejectedCount: number;
  /** Events at/before this source order are excluded, including delayed real events. */
  admissionFloor: { occurredAt: number; hash: string } | null;
};
