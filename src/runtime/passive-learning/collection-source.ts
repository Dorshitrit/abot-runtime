import { randomUUID } from "node:crypto";
import type { HostObservationEvent } from "../../shared/passive-observation.js";
import type { PassiveLearningConnection } from "./contracts.js";

function shouldReconnectCollectionSource(event: HostObservationEvent): boolean {
  if (event.type !== "status") return false;
  if (event.state === "disconnected") return true;
  if (event.state === "failed") return true;
  if (event.state !== "unavailable") return false;
  if (event.reason === "collector_stopped") return true;
  return event.reason === "collector_start_failed";
}

function hasHealthyCollectionEvent(event: HostObservationEvent): boolean {
  if (event.type === "observation") return true;
  return event.state === "collecting" || event.state === "partial";
}

/** A collection lease is independent from the lifetime of queued analysis. */
export class LearningCollectionSource {
  private abort: AbortController | undefined;
  private connection: Readonly<{ close(): void }> | undefined;
  private leaseId = "";
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay = 5_000;

  constructor(
    private readonly options: Readonly<{
      ownerId: string;
      connect?: PassiveLearningConnection;
      enabled(): boolean;
      excludedApplications(): readonly string[];
      opening(): void;
      event(event: HostObservationEvent): void;
      failed(error: unknown): void;
    }>,
  ) {}

  async open(): Promise<void> {
    this.close();
    if (!this.options.enabled()) return;
    this.leaseId = randomUUID();
    const abort = new AbortController();
    this.abort = abort;
    this.options.opening();
    if (!this.options.connect) {
      this.options.failed(new Error("learning_host_unavailable"));
      return;
    }
    try {
      const connection = await this.options.connect({
        ownerId: this.options.ownerId,
        leaseId: this.leaseId,
        abortSignal: abort.signal,
        excludedApplications: this.options.excludedApplications(),
        onEvent: (event) => {
          if (this.abort !== abort || !this.accepts(event)) return;
          if (shouldReconnectCollectionSource(event)) this.reconnect();
          if (hasHealthyCollectionEvent(event)) this.reconnectDelay = 5_000;
          this.options.event(event);
        },
      });
      if (abort.signal.aborted) {
        connection.close();
        return;
      }
      this.connection = connection;
    } catch (error) {
      if (abort.signal.aborted) return;
      this.options.failed(error);
      this.reconnect();
    }
  }

  accepts(event: HostObservationEvent): boolean {
    if (!this.options.enabled() || !this.abort || this.abort.signal.aborted)
      return false;
    return (
      event.ownerId === this.options.ownerId && event.leaseId === this.leaseId
    );
  }

  close(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.abort?.abort();
    this.connection?.close();
    this.connection = undefined;
    this.abort = undefined;
  }

  private reconnect(): void {
    if (!this.options.enabled() || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.open().catch(this.options.failed);
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(30_000, this.reconnectDelay * 2);
    this.reconnectTimer.unref?.();
  }
}
