import { approvalNotificationKey, notificationIdentity } from "./identity.js";
import { isSparkSession } from "../../sessions/spark-session.js";
import { hasAutomationSessionOrigin } from "../../sessions/automation-session-origin.js";
import type { WebNotification, NotificationKind } from "./contracts.js";
import { projectAutomationRunNotificationEvent } from "./automation-event-projection.js";
import { eventText, hasNotificationIdentity, notificationBody } from "./event-fields.js";
import { conversationNotificationSource, type NotificationSession } from "./conversation-source.js";

function stoppedResponse(event: Record<string, unknown>): string {
  const details = event.details;
  if (!details || typeof details !== "object" || Array.isArray(details))
    return "";
  return notificationBody(
    eventText((details as Record<string, unknown>).stoppedResponse),
  );
}

function isCancelledRequestEvent(event: Record<string, unknown>): boolean {
  if (event.errorCode === "request_cancelled") return true;
  return event.error === "request_cancelled";
}

function isAutomationChildReply(
  event: Record<string, unknown>,
  persistedSession?: NotificationSession | null,
): boolean {
  if (event.type !== "completed") return false;
  if (!persistedSession) return false;
  return hasAutomationSessionOrigin(persistedSession);
}

type ProjectedNotification = {
  kind: Exclude<NotificationKind, "automation">;
  key: string;
  title: string;
  body: string;
  sessionId: string;
};

function failedNotification(
  event: Record<string, unknown>,
): ProjectedNotification | undefined {
  const sessionId = eventText(event.sessionId);
  const key = eventText(event.requestId);
  if (!isCancelledRequestEvent(event))
    return {
      kind: "failure",
      key,
      sessionId,
      title: "Request could not finish",
      body: "Open the conversation to review what happened.",
    };
  const body = stoppedResponse(event);
  if (!body) return;
  return { kind: "reply", key, sessionId, title: "Task stopped", body };
}

function readNotificationEvent(
  event: Record<string, unknown>,
): ProjectedNotification | undefined {
  const sessionId = eventText(event.sessionId);
  const requestId = eventText(event.requestId);
  if (event.type === "completed") {
    const output = notificationBody(eventText(event.output));
    if (!output) return;
    return {
      kind: "reply",
      key: requestId,
      sessionId,
      title: "New agent reply",
      body: output,
    };
  }
  if (event.type === "failed") return failedNotification(event);
  if (event.name === "tool.approval.required") {
    const approvalId = eventText(event.approvalId);
    if (!hasNotificationIdentity(requestId)) return;
    if (!hasNotificationIdentity(approvalId)) return;
    const key = approvalNotificationKey(requestId, approvalId);
    return {
      kind: "approval",
      key,
      sessionId,
      title: "Your approval is needed",
      body: "The agent is waiting for your decision. Open the conversation to review the action.",
    };
  }
  if (event.type !== "learning.changed") return;
  const change = event.event;
  if (!change || typeof change !== "object" || Array.isArray(change)) return;
  const proposal = change as Record<string, unknown>;
  if (proposal.type !== "proposal_delivered") return;
  return {
    kind: "proposal",
    key: eventText(proposal.proposalId),
    sessionId: eventText(proposal.sessionId),
    title: "New SPARK suggestion",
    body: "SPARK has a new suggestion for you. Open the conversation to review it.",
  };
}

/** Observe committed client output; replay and progress never create new records. */
export function projectNotificationEvent(
  event: Record<string, unknown>,
  now: number,
  persistedSession?: NotificationSession | null,
): WebNotification | undefined {
  if (event.sessionDeleted === true) return;
  if (isAutomationChildReply(event, persistedSession)) return;
  const automation = projectAutomationRunNotificationEvent(event, now);
  if (automation) return automation;
  const environmentId =
    eventText(event.environment) || eventText(event.environmentId);
  if (!hasNotificationIdentity(environmentId)) return;
  const projected = readNotificationEvent(event);
  if (!projected) return;
  if (!hasNotificationIdentity(projected.key)) return;
  if (!hasNotificationIdentity(projected.sessionId)) return;
  const id = notificationIdentity(environmentId, projected.kind, projected.key);
  const requestId = eventText(event.requestId);
  return {
    id,
    kind: projected.kind,
    title: projected.title,
    body: projected.body,
    createdAt: now,
    readAt: null,
    environmentId,
    sessionId: projected.sessionId,
    ...(persistedSession && isSparkSession(persistedSession) ? { sessionKind: "spark" as const } : {}),
    ...(hasNotificationIdentity(requestId) ? { requestId } : {}),
    sourceUrl: conversationNotificationSource(environmentId, projected.sessionId, event, persistedSession),
    delivery: { status: "pending" },
  };
}
