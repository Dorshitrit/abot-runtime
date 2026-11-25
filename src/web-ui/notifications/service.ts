import type { RuntimeConfig } from "../../runtime/ports.js";
import { assertValidSessionId } from "../../sessions/record/rules.js";
import { loadSessionFile } from "../../sessions/session-store.js";
import { isSparkSession } from "../../sessions/spark-session.js";
import type {
  AgentReplyNotification,
  AutomationReportRead,
  NotificationDelivery,
  NotificationDesktopState,
  NotificationListQuery,
  NotificationPreferences,
  NotificationReadChange,
  WebNotification,
} from "./contracts.js";
import { approvalNotificationKey, automationNotificationIdentity, notificationIdentity } from "./identity.js";
import { NotificationDeliveryQueue } from "./delivery-queue.js";
import { projectNotificationEvent } from "./event-projection.js";
import { WebNotificationStore, notificationStorePath } from "./store.js";
import { isReplyReadCandidate, synchronizeReplyNotifications, type NotificationReadEvidence } from "./reply-read-sync.js";
import type { NotificationIssueOccurrence } from "./issue-contracts.js";
import { NotificationIssueBatch } from "./issue-batch.js";
import { isNotificationIssueOccurrence } from "./issue-schema.js";
import { linkedTerminalIssue, projectNotificationIssue } from "./issue-source-projection.js";
import { notificationIssueGroupKey } from "./issue-groups.js";

type NotificationEnvironment = { services: { config: RuntimeConfig } };
export type NotificationServiceOptions = {
  hasEnvironment(id: string): boolean;
  environment(id: string): NotificationEnvironment;
  isViewing(environmentId: string, sessionId: string): boolean;
  isViewingAgent?(environmentId: string, agentId: string): boolean;
  changed(environmentId: string): void;
  desktop(): Promise<NotificationDesktopState>;
  deliver(
    item: WebNotification,
    signal: AbortSignal,
  ): Promise<NotificationDelivery>;
  now?: () => number;
  readEvidence?: NotificationReadEvidence;
};

function isSuppressedReply(
  item: WebNotification,
  options: NotificationServiceOptions,
): boolean {
  if (item.kind !== "reply" || !item.sessionId) return false;
  return options.isViewing(item.environmentId, item.sessionId);
}

function hasValidPersistedSessionReference(sessionId: unknown): sessionId is string {
  if (typeof sessionId !== "string") return false;
  try {
    assertValidSessionId(sessionId);
    return true;
  } catch {
    return false;
  }
}

function isCompletedConversationNotification(
  event: Record<string, unknown>,
  item: WebNotification,
): item is WebNotification & { sessionId: string } {
  if (event.type !== "completed") return false;
  return item.kind !== "automation";
}

function permitsDesktopNotification(
  preferences: NotificationPreferences,
  item: WebNotification,
): boolean {
  if (item.severity === "error" || item.channel === "in-app") return false;
  if (!preferences.desktopEnabled) return false;
  return preferences.kinds[item.kind];
}

/** Owns UI notification records, never session history or model execution. */
export class WebNotificationService {
  private readonly stores = new Map<string, Promise<WebNotificationStore>>();
  private queue: Promise<void> = Promise.resolve();
  private readonly deliveries = new NotificationDeliveryQueue();
  private readonly abort = new AbortController();
  private readonly now: () => number;
  private readonly issues: NotificationIssueBatch;

  constructor(private readonly options: NotificationServiceOptions) {
    this.now = options.now ?? Date.now;
    this.issues = new NotificationIssueBatch(async (environmentId, items) => {
      const bound = await this.bindIssueSources(environmentId, items);
      const result = await (await this.store(environmentId)).ingestIssues(bound);
      if (result.accepted || result.rejected) this.options.changed(environmentId);
    }, (error) => this.reportFailure("issue collection", error));
  }

  /** Resolve only the latest source per group, sharing one canonical session load across representatives. */
  private async bindIssueSources(environmentId: string, occurrences: readonly NotificationIssueOccurrence[]) {
    const latest = new Map<string, NotificationIssueOccurrence>();
    for (const occurrence of occurrences) {
      const key = notificationIssueGroupKey(occurrence.grouping);
      const previous = latest.get(key);
      if (!previous || occurrence.occurredAt >= previous.occurredAt) latest.set(key, occurrence);
    }
    const sessions = new Set([...latest.values()].flatMap((item) => item.source ? [item.source.sessionId] : []));
    const { sessionsDir } = this.options.environment(environmentId).services.config.paths;
    const kinds = new Map(await Promise.all([...sessions].map(async (sessionId) => {
      const persisted = await loadSessionFile(sessionsDir, sessionId);
      return [sessionId, persisted && isSparkSession(persisted) ? "spark" as const : undefined] as const;
    })));
    return occurrences.map((item) => {
      if (!item.source) return item;
      const { sessionKind: _unverified, ...source } = item.source;
      const sessionKind = kinds.get(source.sessionId);
      return { ...item, source: { ...source, ...(sessionKind ? { sessionKind } : {}) } };
    });
  }

  hasEnvironment = (id: string): boolean => {
    return this.options.hasEnvironment(id);
  };

  private store(environmentId: string): Promise<WebNotificationStore> {
    const { paths } = this.options.environment(environmentId).services.config;
    const path = notificationStorePath({
      environmentId,
      runtimeDir: paths.runtimeDir,
      sessionsDir: paths.sessionsDir,
    });
    const existing = this.stores.get(path);
    if (existing) return existing;
    const store = new WebNotificationStore(path, environmentId, {
      now: this.now, onPruned: () => this.options.changed(environmentId),
    });
    const opening = this.reconcileInterruptedDelivery(store).catch((error) => {
      this.stores.delete(path);
      throw error;
    });
    this.stores.set(path, opening);
    return opening;
  }

  private async reconcileInterruptedDelivery(store: WebNotificationStore) {
    await store.reconcilePendingDeliveries();
    return store;
  }

  observe(event: Record<string, unknown>): void {
    if (this.abort.signal.aborted) return;
    const issue = projectNotificationIssue(event);
    if (issue) { this.observeIssue(issue); return; }
    const observedAt = this.now();
    const item = projectNotificationEvent(event, observedAt);
    if (!item || isSuppressedReply(item, this.options)) return;
    if (!this.hasEnvironment(item.environmentId)) return;
    if (item.kind !== "automation" &&
        !hasValidPersistedSessionReference(item.sessionId)) return;
    this.queue = this.queue
      .then(async () => {
        if (item.kind === "automation") return this.record(item);
        if (!hasValidPersistedSessionReference(item.sessionId)) return;
        const linked = linkedTerminalIssue(event);
        if (linked) {
          await this.issues.flush(item.environmentId);
          if (await (await this.store(item.environmentId)).hasIssueOccurrence(linked.namespace, linked.occurrenceId)) return;
        }
        const { sessionsDir } = this.options.environment(item.environmentId).services.config.paths;
        const persisted = await loadSessionFile(sessionsDir, item.sessionId);
        const hasPersistedConversation = persisted !== null;
        if (!hasPersistedConversation && isCompletedConversationNotification(event, item)) return;
        const projected = projectNotificationEvent(event, observedAt, persisted);
        if (projected) await this.record(projected);
      })
      .catch((error) => this.reportFailure(item.environmentId, error));
  }

  /** Trusted internal producers can add sources without changing storage, grouping or delivery policy. */
  observeIssue(occurrence: NotificationIssueOccurrence): void {
    if (this.abort.signal.aborted || !this.hasEnvironment(occurrence.environmentId)) return;
    if (!isNotificationIssueOccurrence(occurrence, occurrence.environmentId)) return;
    if (occurrence.source && !hasValidPersistedSessionReference(occurrence.source.sessionId)) return;
    this.issues.enqueue(structuredClone(occurrence));
  }

  recordAgentReply = async (item: AgentReplyNotification, historical: boolean) => {
    if (this.abort.signal.aborted || !this.hasEnvironment(item.environmentId)) return;
    const viewing = this.options.isViewingAgent?.(item.environmentId, item.agentSource.agentId) === true;
    await this.record(item, historical || viewing);
  };

  forgetAgentReplies = async (environment: string, agentId: string) => (await this.store(environment)).forgetAgentReplies(agentId);
  unreadAgentReplies = async (environment: string) => (await this.store(environment)).getUnreadAgentReplies();
  readAgentReplies = (environment: string, ids: string[]) => this.markSourceRead(environment, ids);

  private async record(item: WebNotification, quiet = false): Promise<void> {
    const store = await this.store(item.environmentId);
    const preferences = await store.getPreferences();
    const shouldDeliver = !quiet && permitsDesktopNotification(preferences, item);
    const result = await store.upsert({
      ...item,
      delivery: { status: shouldDeliver ? "pending" : "disabled" },
    });
    if (!result.created) return;
    if (isReplyReadCandidate(item)) await this.reconcileReplyReads(item.environmentId, item.sessionId);
    this.options.changed(item.environmentId);
    if (!shouldDeliver) return;
    void this.deliveries
      .enqueue(() => this.deliver(store, result.item))
      .catch((error) => this.reportFailure(item.environmentId, error));
  }

  private canSubmitDesktopNotification(): boolean {
    return !this.abort.signal.aborted;
  }

  private async desktopOutcome(
    item: WebNotification,
    preferences: NotificationPreferences,
  ): Promise<NotificationDelivery> {
    if (!this.canSubmitDesktopNotification())
      return {
        status: "unavailable",
        error: "ABot stopped before desktop delivery started.",
      };
    if (!permitsDesktopNotification(preferences, item))
      return { status: "disabled" };
    try {
      return await this.options.deliver(item, this.abort.signal);
    } catch {
      return {
        status: "unknown",
        error: "Desktop delivery was not confirmed.",
      };
    }
  }

  private async deliver(store: WebNotificationStore, item: WebNotification) {
    if (isReplyReadCandidate(item)) await this.reconcileReplyReads(item.environmentId, item.sessionId);
    const current = await store.get(item.id);
    if (!current) return;
    if (current.agentSource && (current.readAt !== null || this.options.isViewingAgent?.(current.environmentId, current.agentSource.agentId))) {
      await store.updateDelivery(current.id, { status: "disabled" });
      return;
    }
    const preferences = await store.getPreferences();
    const delivery = await this.desktopOutcome(current, preferences);
    await store.updateDelivery(item.id, delivery);
    this.options.changed(item.environmentId);
  }

  private reportFailure(environmentId: string, error: unknown): void {
    console.error(
      `Notification history unavailable for ${environmentId}:`,
      error,
    );
  }

  private async reconcileReplyReads(environmentId: string, sessionId?: string): Promise<void> {
    if (!this.options.readEvidence) return;
    const store = await this.store(environmentId);
    const updated = await synchronizeReplyNotifications(store, environmentId, this.options.readEvidence, sessionId);
    if (updated) this.options.changed(environmentId);
  }

  observeRead = (environmentId: string, sessionId: string): void => {
    if (this.abort.signal.aborted) return;
    this.queue = this.queue
      .then(() => this.reconcileReplyReads(environmentId, sessionId))
      .catch((error) => this.reportFailure(environmentId, error));
  };

  observeApprovalDecision = (decision: {
    environmentId: string; requestId: string; approvalId: string;
  }): void => {
    if (this.abort.signal.aborted) return;
    const { environmentId, requestId, approvalId } = decision;
    const id = notificationIdentity(environmentId, "approval", approvalNotificationKey(requestId, approvalId));
    this.queue = this.queue
      .then(() => this.markSourceRead(environmentId, [id]))
      .then(() => undefined)
      .catch((error) => this.reportFailure(environmentId, error));
  };

  markAutomationReportRead = (environmentId: string, report: AutomationReportRead) => {
    const phases = report.phase === "finished" ? ["started", "finished"] as const : ["started"] as const;
    return this.markSourceRead(environmentId,
      phases.map((phase) => automationNotificationIdentity(environmentId, report.runId, phase)));
  };

  private async markSourceRead(environmentId: string, ids: string[]) {
    const result = await (await this.store(environmentId)).markSourceRead(ids, this.now());
    if (result.updated) this.options.changed(environmentId);
    return result;
  }

  list = async (environmentId: string, query?: NotificationListQuery) => {
    await this.issues.flush(environmentId);
    await this.reconcileReplyReads(environmentId);
    const page = await (await this.store(environmentId)).list(query);
    page.issueCoverage.collectionRejectedCount = this.issues.rejectedCount(environmentId);
    return page;
  };

  desktop = (_environmentId: string) => this.options.desktop();

  markRead = async (environmentId: string, change: NotificationReadChange) => {
    await this.issues.flush(environmentId);
    const result = await (
      await this.store(environmentId)
    ).markRead(change, this.now());
    if (result.updated) this.options.changed(environmentId);
    return result;
  };

  setPreferences = async (
    environmentId: string,
    preferences: NotificationPreferences,
  ) => {
    const result = await (
      await this.store(environmentId)
    ).setPreferences(preferences);
    this.options.changed(environmentId);
    return result;
  };

  async flush(): Promise<void> {
    const [issues] = await Promise.allSettled([this.issues.flush(), this.queue]);
    await this.deliveries.flush();
    if (issues.status === "rejected") throw issues.reason;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.flush();
  }
}
