import type { RuntimeConfig } from "../../runtime/ports.js";
import type {
  NotificationDelivery,
  NotificationDesktopState,
  NotificationListQuery,
  NotificationPreferences,
  NotificationReadChange,
  WebNotification,
} from "./contracts.js";
import { NotificationDeliveryQueue } from "./delivery-queue.js";
import { projectNotificationEvent } from "./event-projection.js";
import { WebNotificationStore, notificationStorePath } from "./store.js";

type NotificationEnvironment = { services: { config: RuntimeConfig } };
export type NotificationServiceOptions = {
  hasEnvironment(id: string): boolean;
  environment(id: string): NotificationEnvironment;
  isViewing(environmentId: string, sessionId: string): boolean;
  changed(environmentId: string): void;
  desktop(): Promise<NotificationDesktopState>;
  deliver(
    item: WebNotification,
    signal: AbortSignal,
  ): Promise<NotificationDelivery>;
  now?: () => number;
};

function isSuppressedReply(
  item: WebNotification,
  options: NotificationServiceOptions,
): boolean {
  if (item.kind !== "reply") return false;
  return options.isViewing(item.environmentId, item.sessionId);
}

function permitsDesktopNotification(
  preferences: NotificationPreferences,
  item: WebNotification,
): boolean {
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

  constructor(private readonly options: NotificationServiceOptions) {
    this.now = options.now ?? Date.now;
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
    const store = new WebNotificationStore(path, environmentId);
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
    const item = projectNotificationEvent(event, this.now());
    if (!item || isSuppressedReply(item, this.options)) return;
    if (!this.hasEnvironment(item.environmentId)) return;
    this.queue = this.queue
      .then(() => this.record(item))
      .catch((error) => this.reportFailure(item.environmentId, error));
  }

  private async record(item: WebNotification): Promise<void> {
    const store = await this.store(item.environmentId);
    const preferences = await store.getPreferences();
    const shouldDeliver = permitsDesktopNotification(preferences, item);
    const result = await store.upsert({
      ...item,
      delivery: { status: shouldDeliver ? "pending" : "disabled" },
    });
    if (!result.created) return;
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
    const preferences = await store.getPreferences();
    const delivery = await this.desktopOutcome(item, preferences);
    await store.updateDelivery(item.id, delivery);
    this.options.changed(item.environmentId);
  }

  private reportFailure(environmentId: string, error: unknown): void {
    console.error(
      `Notification history unavailable for ${environmentId}:`,
      error,
    );
  }

  list = async (environmentId: string, query?: NotificationListQuery) =>
    (await this.store(environmentId)).list(query);

  desktop = (_environmentId: string) => this.options.desktop();

  markRead = async (environmentId: string, change: NotificationReadChange) => {
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
    await this.queue;
    await this.deliveries.flush();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.flush();
  }
}
