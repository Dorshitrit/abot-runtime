import { createHash, randomUUID } from "node:crypto";
import type { NotificationReadChange, NotificationReadResult, WebNotification } from "./contracts.js";
import type { NotificationIssueCoverage, NotificationIssueOccurrence } from "./issue-contracts.js";
import { admitsIssueReceipt, ISSUE_RECEIPT_LIMIT, issueOccurrenceHash, pruneIssueReceipts } from "./issue-receipts.js";
import { NOTIFICATION_RETENTION_MS, applyNotificationRetention } from "./retention.js";
import type { NotificationStoreState } from "./storage-schema.js";

export function notificationIssueGroupKey(group: NotificationIssueOccurrence["grouping"]): string {
  const configuration = Object.entries(group.configuration ?? {}).sort(([a], [b]) => a < b ? -1 : a === b ? 0 : 1);
  return createHash("sha256").update(JSON.stringify([
    group.source, group.provider ?? null, group.profile ?? null, group.cause, group.remediationTarget, configuration,
  ])).digest("base64url");
}

function sourceFields(occurrence: NotificationIssueOccurrence) {
  const query = new URLSearchParams({ environment: occurrence.environmentId });
  if (occurrence.source) {
    if (occurrence.source.sessionKind === "spark") {
      query.set("spark", "1");
      return { ...occurrence.source, sourceUrl: `/home?${query}` };
    }
    query.set("session", occurrence.source.sessionId);
    return { ...occurrence.source, sourceUrl: `/chat?${query}` };
  }
  return { sourceUrl: `/notifications?${query}` };
}

/** Counter, identity receipts, reopening and retention form one store transaction. */
export function ingestNotificationIssues(state: NotificationStoreState, occurrences: readonly NotificationIssueOccurrence[], now: number) {
  const issueState = state.issues ??= { sequence: 0, receipts: [], rejectedCount: 0 };
  pruneIssueReceipts(issueState, now);
  const seen = new Set(issueState.receipts.map((receipt) => receipt.hash));
  const groups = new Map(state.items.filter((item) => item.issue).map((item) => [item.issue!.groupKey, item]));
  let accepted = 0;
  let rejected = 0;
  let duplicate = 0;
  for (const occurrence of occurrences) {
    const receipt = { hash: issueOccurrenceHash(occurrence.namespace, occurrence.occurrenceId), occurredAt: occurrence.occurredAt };
    if (seen.has(receipt.hash)) { duplicate++; continue; }
    if (!admitsIssueReceipt(issueState, receipt, now)) { rejected++; continue; }
    if (issueState.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Notification issue sequence exhausted.");
    issueState.sequence++;
    issueState.receipts.push(receipt);
    seen.add(receipt.hash);
    const groupKey = notificationIssueGroupKey(occurrence.grouping);
    let item = groups.get(groupKey);
    if (!item) {
      item = {
        id: randomUUID(), kind: "failure", severity: "error", channel: "in-app",
        title: occurrence.title, body: occurrence.body, createdAt: occurrence.occurredAt, readAt: null,
        environmentId: state.environmentId, ...sourceFields(occurrence), delivery: { status: "disabled" },
        issue: { groupKey, occurrenceCount: 0, firstOccurredAt: occurrence.occurredAt,
          lastOccurredAt: occurrence.occurredAt, lastSequence: issueState.sequence,
          outcomeCounts: { recovered: 0, failed: 0, interrupted: 0 } },
      };
      state.items.push(item);
      groups.set(groupKey, item);
    }
    const issue = item.issue!;
    issue.occurrenceCount++;
    issue.outcomeCounts[occurrence.outcome]++;
    issue.lastSequence = issueState.sequence;
    issue.firstOccurredAt = Math.min(issue.firstOccurredAt, occurrence.occurredAt);
    if (occurrence.occurredAt >= issue.lastOccurredAt) {
      issue.lastOccurredAt = occurrence.occurredAt;
      item.title = occurrence.title;
      item.body = occurrence.body;
      delete item.sessionId;
      delete item.requestId;
      delete item.sessionKind;
      Object.assign(item, sourceFields(occurrence));
      if (occurrence.action) issue.action = occurrence.action;
      else delete issue.action;
    }
    item.readAt = null;
    accepted++;
  }
  issueState.rejectedCount = Math.min(Number.MAX_SAFE_INTEGER, issueState.rejectedCount + rejected);
  pruneIssueReceipts(issueState, now);
  applyNotificationRetention(state, now);
  return { accepted, rejected, duplicate };
}

export function issueReadIsObserved(item: WebNotification, change: NotificationReadChange): boolean {
  if (!item.issue || !change.read) return true;
  if ("all" in change) return change.issueReadBoundary !== undefined && item.issue.lastSequence <= change.issueReadBoundary;
  return change.observedIssues?.some((observed) => observed.id === item.id && observed.occurrenceCount === item.issue!.occurrenceCount) ?? false;
}

export function notificationCounts(state: NotificationStoreState) {
  let unreadCount = 0;
  let unreadErrorCount = 0;
  for (const item of state.items) {
    if (item.readAt !== null) continue;
    unreadCount++;
    if (item.severity === "error") unreadErrorCount++;
  }
  return {
    unreadCount, unreadErrorCount,
    readBoundary: state.issues?.sequence ?? 0,
  };
}

export function notificationReadSummary(state: NotificationStoreState, updated = 0): NotificationReadResult {
  return { updated, ...notificationCounts(state),
    issueStates: state.items.flatMap((item) => item.issue ? [{
      id: item.id, occurrenceCount: item.issue.occurrenceCount, readAt: item.readAt, issue: item.issue,
      title: item.title, body: item.body, sourceUrl: item.sourceUrl,
      ...(item.sessionId ? { sessionId: item.sessionId } : {}), ...(item.requestId ? { requestId: item.requestId } : {}),
      ...(item.sessionKind ? { sessionKind: item.sessionKind } : {}),
    }] : []),
  };
}

export function notificationIssueCoverage(state: NotificationStoreState): NotificationIssueCoverage {
  return { receiptLimit: ISSUE_RECEIPT_LIMIT, retentionMs: NOTIFICATION_RETENTION_MS,
    rejectedCount: state.issues?.rejectedCount ?? 0, collectionRejectedCount: 0, admissionFloor: state.issues?.floor ?? null };
}
