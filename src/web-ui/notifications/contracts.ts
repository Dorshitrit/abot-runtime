import type { SessionKind } from "../../sessions/spark-session.js";
import type { NotificationIssue, NotificationIssueCoverage, NotificationIssueReadState } from "./issue-contracts.js";

export type NotificationKind =
  | "reply"
  | "failure"
  | "approval"
  | "proposal"
  | "automation";

export type NotificationDelivery = {
  status:
    | "pending"
    | "submitted"
    | "disabled"
    | "unavailable"
    | "failed"
    | "unknown";
  error?: string;
};

type NotificationDetails = {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
  environmentId: string;
  sourceUrl: string;
  agentSource?: { agentId: string; missionId: string; messageId: string };
  delivery: NotificationDelivery;
  severity?: "error";
  channel?: "in-app";
  issue?: NotificationIssue;
};

export type AgentReplyNotification = NotificationDetails & {
  kind: "reply" | "failure" | "approval";
  agentSource: NonNullable<NotificationDetails["agentSource"]>;
  sessionId?: never;
  sessionKind?: never;
  requestId?: never;
  automationId?: never;
  runId?: never;
};

export type WebNotification = NotificationDetails &
  (
    | AgentReplyNotification
    | {
        kind: "failure";
        severity: "error";
        channel: "in-app";
        issue: NotificationIssue;
        sessionId?: string;
        sessionKind?: SessionKind;
        requestId?: string;
        automationId?: never;
        runId?: never;
      }
    | {
        kind: "automation";
        automationId: string;
        runId: string;
        sessionId?: never;
        sessionKind?: never;
        requestId?: never;
      }
    | {
        kind: Exclude<NotificationKind, "automation">;
        sessionId: string;
        /** Copied only from the canonical persisted session. */
        sessionKind?: SessionKind;
        requestId?: string;
        automationId?: never;
        runId?: never;
      }
  );

export type NotificationPreferences = {
  desktopEnabled: boolean;
  kinds: Record<NotificationKind, boolean>;
};

export type NotificationListQuery = { limit?: number; before?: string };
export type NotificationPage = {
  items: WebNotification[];
  unreadCount: number;
  unreadErrorCount: number;
  readBoundary: number;
  issueCoverage: NotificationIssueCoverage;
  nextCursor: string | null;
  preferences: NotificationPreferences;
};
export type NotificationReadChange =
  | { ids: string[]; read: boolean; observedIssues?: { id: string; occurrenceCount: number }[] }
  | { all: true; read: true; issueReadBoundary?: number };
export type AutomationReportRead = { runId: string; phase: "started" | "finished" };
export type NotificationReadResult = {
  updated: number; unreadCount: number; unreadErrorCount: number; readBoundary: number;
  issueStates: NotificationIssueReadState[];
};
export type NotificationDesktopState = {
  available: boolean;
  message?: string;
  computerName?: string;
};

export class NotificationInputError extends Error {}

export function defaultNotificationPreferences(): NotificationPreferences {
  return {
    desktopEnabled: true,
    kinds: {
      reply: true,
      failure: true,
      approval: true,
      proposal: true,
      automation: true,
    },
  };
}
