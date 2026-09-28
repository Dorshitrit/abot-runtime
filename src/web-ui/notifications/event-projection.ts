import { createHash } from "node:crypto";
import type { WebNotification, NotificationKind } from "./contracts.js";

function eventText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasNotificationIdentity(value: string): boolean {
  if (!value.trim() || value.length > 512) return false;
  return !/[\u0000-\u001f\u007f]/u.test(value);
}

function notificationBody(value: string): string {
  const readable = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  return [...readable.replace(/\s+/gu, " ").trim()].slice(0, 600).join("");
}

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

type ProjectedNotification = {
  kind: NotificationKind;
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
    const key = createHash("sha256")
      .update(JSON.stringify([requestId, approvalId]))
      .digest("hex");
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
    title: "New Co-worker suggestion",
    body: "Co-worker has a new suggestion for you. Open the conversation to review it.",
  };
}

/** Observe committed client output; replay and progress never create new records. */
export function projectNotificationEvent(
  event: Record<string, unknown>,
  now: number,
): WebNotification | undefined {
  if (event.sessionDeleted === true) return;
  const environmentId =
    eventText(event.environment) || eventText(event.environmentId);
  if (!hasNotificationIdentity(environmentId)) return;
  const projected = readNotificationEvent(event);
  if (!projected) return;
  if (!hasNotificationIdentity(projected.key)) return;
  if (!hasNotificationIdentity(projected.sessionId)) return;
  const id = createHash("sha256")
    .update(JSON.stringify([environmentId, projected.kind, projected.key]))
    .digest("hex");
  const parameters = new URLSearchParams({
    environment: environmentId,
    session: projected.sessionId,
  });
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
    ...(hasNotificationIdentity(requestId) ? { requestId } : {}),
    sourceUrl: `/chat?${parameters}`,
    delivery: { status: "pending" },
  };
}
