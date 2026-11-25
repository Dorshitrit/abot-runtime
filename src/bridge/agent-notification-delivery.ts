import type WebSocket from "ws";
import { AGENT_NOTIFICATION_RETENTION_MS, type AgentNotificationSource } from "../runtime/agents/notification-attention.js";
import type { AgentNotificationJournal, AgentNotificationJournalStore } from "./agent-notification-journal.js";

export const AGENT_NOTIFICATIONS_FEATURE = "agents_notifications_v1";
type PendingAck = { eventId: string; finish(acknowledged: boolean): void };

/** The Socket ACK means the inbox transaction is durable, not that a phone displayed it. */
export function createAgentNotificationDelivery(input: {
  source: AgentNotificationSource;
  journal: AgentNotificationJournalStore;
  subscribe?: (listener: (revision: number) => void) => () => void;
  now?: () => number;
  acknowledgementMs?: number;
  retryMs?: number;
  onError?: () => void;
}) {
  const now = input.now ?? Date.now;
  let socket: WebSocket | undefined;
  let stopped = false, dirty = false, errorReported = false;
  let cycle: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ack: PendingAck | undefined;
  let state: AgentNotificationJournal | undefined;

  function isConnected(current: WebSocket): boolean {
    return !stopped && socket === current && current.readyState === 1;
  }
  function report() {
    if (!errorReported) input.onError?.();
    errorReported = true;
  }
  function scheduleRetry() {
    if (stopped || !socket || retry) return;
    retry = setTimeout(() => { retry = undefined; changed(); }, input.retryMs ?? 5_000);
    retry.unref?.();
  }
  async function send(current: WebSocket, entry: NonNullable<AgentNotificationJournal["pending"]>["entries"][number]): Promise<boolean> {
    if (!isConnected(current)) return false;
    return new Promise<boolean>(resolve => {
      let finished = false;
      const timer = setTimeout(() => finish(false), input.acknowledgementMs ?? 15_000);
      timer.unref?.();
      function finish(acknowledged: boolean) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (ack?.finish === finish) ack = undefined;
        resolve(acknowledged);
      }
      ack = { eventId: entry.eventId, finish };
      try {
        current.send(JSON.stringify({ type: "agents.notification", ...entry }), error => {
          if (error) finish(false);
        });
      } catch { finish(false); }
    });
  }
  async function drain(current: WebSocket) {
    let snapshot: AgentNotificationJournal = state ?? await input.journal.read();
    state = snapshot;
    while (dirty && isConnected(current)) {
      dirty = false;
      if (!snapshot.pending) {
        const page = await input.source.read(snapshot.cursor, Math.max(snapshot.activatedAt, now() - AGENT_NOTIFICATION_RETENTION_MS));
        if (!isConnected(current)) return;
        const pending = { cursor: page.cursor, entries: page.entries.filter(entry => entry.expiresAt > now()) };
        if (!pending.entries.length) {
          const next: AgentNotificationJournal = { version: 1 as const, activatedAt: snapshot.activatedAt, cursor: pending.cursor };
          if (JSON.stringify(next) !== JSON.stringify(snapshot)) await input.journal.write(next);
          state = snapshot = next;
          continue;
        }
        const next: AgentNotificationJournal = { ...snapshot, pending };
        await input.journal.write(next);
        state = snapshot = next;
      }
      const pending = snapshot.pending!;
      for (const entry of pending.entries) {
        if (!isConnected(current)) return;
        if (entry.expiresAt <= now()) continue;
        if (!await send(current, entry)) { scheduleRetry(); return; }
      }
      const next: AgentNotificationJournal = { version: 1 as const, activatedAt: snapshot.activatedAt, cursor: pending.cursor };
      await input.journal.write(next);
      state = snapshot = next;
      errorReported = false;
      // New source records may have arrived while this batch awaited durable ACKs.
      dirty = true;
    }
  }
  function pump() {
    if (cycle || retry || stopped || !socket || !dirty) return;
    const current = socket;
    cycle = drain(current).catch(() => { report(); scheduleRetry(); }).finally(() => {
      cycle = undefined;
      if (!retry && dirty) pump();
    });
  }
  function changed() {
    if (stopped) return;
    dirty = true;
    pump();
  }
  const unsubscribe = input.subscribe?.(changed);
  return {
    registered(current: WebSocket, message: Record<string, unknown>) {
      const capability = message.agentNotifications;
      if (!capability || typeof capability !== "object" || (capability as { version?: unknown }).version !== 1) return;
      socket = current;
      changed();
    },
    receive(current: WebSocket, message: Record<string, unknown>): boolean {
      if (message.type !== "agents.notification.ack") return false;
      if (!isConnected(current)) return true;
      if (ack && message.eventId === ack.eventId) ack.finish(true);
      return true;
    },
    disconnect(current: WebSocket) {
      if (socket !== current) return;
      socket = undefined;
      if (retry) clearTimeout(retry);
      retry = undefined;
      ack?.finish(false);
    },
    async stop() {
      stopped = true;
      socket = undefined;
      unsubscribe?.();
      if (retry) clearTimeout(retry);
      retry = undefined;
      ack?.finish(false);
      await cycle;
    },
  };
}
