import type { NotificationIssue, NotificationIssueAction, NotificationIssueOccurrence } from "./issue-contracts.js";
import { SPARK_SESSION_ID } from "../../sessions/spark-session.js";
import { hasOnlyNotificationFields as only, isNotificationIdentifier as id, isNotificationRecord as record, isNotificationTimestamp as timestamp } from "./storage-fields.js";

export const isIssueCounter = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
export const isIssueHash = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);

export function isNotificationIssueAction(value: unknown, environmentId: string): value is NotificationIssueAction {
  if (!record(value)) return false;
  if (value.kind === "model-settings")
    return only(value, ["kind", "profileId"]) && id(value.profileId);
  if (value.kind !== "step-timeout" || !only(value, ["kind", "reference"]) || !record(value.reference)) return false;
  const ref = value.reference;
  return only(ref, ["environment", "sessionId", "requestId", "invocationId"]) &&
    ref.environment === environmentId && id(ref.sessionId) && id(ref.requestId) && id(ref.invocationId);
}

export function isNotificationIssue(value: unknown, environmentId: string): value is NotificationIssue {
  if (!record(value) || !only(value, ["groupKey", "occurrenceCount", "firstOccurredAt", "lastOccurredAt", "outcomeCounts", "lastSequence", "action"])) return false;
  if (!isIssueHash(value.groupKey) || !isIssueCounter(value.occurrenceCount) || value.occurrenceCount < 1 ||
    !isIssueCounter(value.lastSequence) || value.lastSequence < 1 ||
    !timestamp(value.firstOccurredAt) || !timestamp(value.lastOccurredAt) || value.firstOccurredAt > value.lastOccurredAt) return false;
  const counts = value.outcomeCounts;
  if (!record(counts) || !only(counts, ["recovered", "failed", "interrupted"]) ||
    !isIssueCounter(counts.recovered) || !isIssueCounter(counts.failed) || !isIssueCounter(counts.interrupted)) return false;
  if (counts.recovered + counts.failed + counts.interrupted !== value.occurrenceCount) return false;
  return value.action === undefined || isNotificationIssueAction(value.action, environmentId);
}

/** This normalized boundary accepts only bounded presentation/configuration fields, never provider payloads. */
export function isNotificationIssueOccurrence(value: unknown, environmentId: string): value is NotificationIssueOccurrence {
  if (!record(value) || !only(value, ["environmentId", "namespace", "occurrenceId", "occurredAt", "outcome", "grouping", "title", "body", "source", "action"])) return false;
  if (value.environmentId !== environmentId || !id(value.namespace) || !id(value.occurrenceId) || !timestamp(value.occurredAt) ||
    !["recovered", "failed", "interrupted"].includes(String(value.outcome))) return false;
  if (typeof value.title !== "string" || !value.title.trim() || value.title.length > 1024 ||
    typeof value.body !== "string" || value.body.length > 4096) return false;
  const group = value.grouping;
  if (!record(group) || !only(group, ["source", "provider", "profile", "cause", "remediationTarget", "configuration"]) ||
    !id(group.source) || !id(group.cause) || !id(group.remediationTarget) ||
    (group.provider !== undefined && !id(group.provider)) || (group.profile !== undefined && !id(group.profile))) return false;
  if (group.configuration !== undefined) {
    if (!record(group.configuration) || Object.keys(group.configuration).length > 20) return false;
    for (const [key, field] of Object.entries(group.configuration)) {
      if (!id(key) || key.length > 64) return false;
      if (field !== null && typeof field !== "boolean" &&
        !(typeof field === "number" && Number.isFinite(field)) &&
        !(typeof field === "string" && field.length <= 512)) return false;
    }
  }
  if (value.source !== undefined && (!record(value.source) || !only(value.source, ["sessionId", "requestId", "sessionKind"]) ||
    !id(value.source.sessionId) || (value.source.requestId !== undefined && !id(value.source.requestId)) ||
    (value.source.sessionKind !== undefined && (value.source.sessionKind !== "spark" || value.source.sessionId !== SPARK_SESSION_ID)))) return false;
  if (value.action !== undefined && !isNotificationIssueAction(value.action, environmentId)) return false;
  if (record(value.action) && value.action.kind === "step-timeout") {
    const ref = (value.action as NotificationIssueAction & { kind: "step-timeout" }).reference;
    if (!record(value.source) || ref.sessionId !== value.source.sessionId || ref.requestId !== value.source.requestId) return false;
  }
  return true;
}
