import { createHash } from "node:crypto";
import type WebSocket from "ws";
import { afterEach, expect, test, vi } from "vitest";
import { createAgentNotificationDelivery } from "../../bridge/agent-notification-delivery.js";
import type { AgentNotificationJournal, AgentNotificationJournalStore } from "../../bridge/agent-notification-journal.js";
import { AGENT_NOTIFICATION_RETENTION_MS, emptyAgentNotificationCursor, type AgentNotificationEntry } from "../agents/notification-attention.js";

const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 2 });
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of disposers.splice(0)) await stop(); });
function entry(messageId: string, createdAt = 2_000): AgentNotificationEntry {
  return { eventId: createHash("sha256").update(messageId).digest("hex"), targetAgentId: "a", missionId: "mission", messageId,
    reason: "reply", createdAt, expiresAt: createdAt + AGENT_NOTIFICATION_RETENTION_MS, output: "The model's public reply" };
}
function setup(entries: AgentNotificationEntry[] = []) {
  let saved: AgentNotificationJournal = { version: 1, activatedAt: 1_000, cursor: emptyAgentNotificationCursor() };
  let changed = () => {};
  const store: AgentNotificationJournalStore = {
    read: vi.fn(async () => structuredClone(saved)),
    write: vi.fn(async value => { saved = structuredClone(value); }),
  };
  const source = { read: vi.fn(async (cursor, since) => ({
    cursor: { attention: [{ agentId: "a", messages: entries.length, traces: 0 }], waits: [] },
    entries: entries.slice(cursor.attention[0]?.messages ?? 0).filter(value => value.createdAt > since),
  })) } satisfies Parameters<typeof createAgentNotificationDelivery>[0]["source"];
  const frames: Record<string, unknown>[] = [];
  const socket = { readyState: 1, send(raw: string, callback?: (error?: Error) => void) {
    frames.push(JSON.parse(raw) as Record<string, unknown>); callback?.();
  } } as WebSocket;
  const make = (acknowledgementMs = 500) => {
    const delivery = createAgentNotificationDelivery({ source, journal: store, now: () => 3_000, acknowledgementMs, retryMs: 10,
      subscribe(listener) { changed = () => listener(1); return () => { changed = () => {}; }; }, onError: errors });
    disposers.push(delivery.stop);
    return delivery;
  };
  const errors = vi.fn();
  const ack = (delivery: ReturnType<typeof make>, value: Record<string, unknown>, connection = socket) =>
    delivery.receive(connection, { type: "agents.notification.ack", eventId: value.eventId });
  return { source, store, frames, socket, make, errors, ack, changed: () => changed(), saved: () => saved };
}

test("only an explicit Socket protocol ACK enables delivery; persisted old history stays quiet", async () => {
  const f = setup([entry("old", 500), entry("new")]), delivery = f.make();
  delivery.registered(f.socket, { features: ["agents_notifications_v1"] });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.source.read).not.toHaveBeenCalled();
  delivery.registered(f.socket, { agentNotifications: { version: 1 } });
  await waitFor(() => expect(f.frames).toHaveLength(1));
  expect(f.frames[0]).toMatchObject({ type: "agents.notification", messageId: "new" });
  expect(f.saved().pending?.entries).toHaveLength(1);
  expect(f.saved().cursor.attention).toEqual([]);
  f.ack(delivery, f.frames[0]!);
  await waitFor(() => expect(f.saved().cursor.attention[0]?.messages).toBe(2));
  expect(f.saved().pending).toBeUndefined();
});

test("lost ACK and restart replay the exact persisted batch; a foreign socket ACK cannot advance it", async () => {
  const f = setup([entry("one")]), first = f.make();
  first.registered(f.socket, { agentNotifications: { version: 1 } });
  await waitFor(() => expect(f.frames.length).toBeGreaterThan(0));
  const original = f.frames[0]!;
  first.disconnect(f.socket);
  await first.stop();
  f.source.read.mockResolvedValue({ cursor: { attention: [{ agentId: "a", messages: 1, traces: 0 }], waits: [] }, entries: [] });
  f.frames.length = 0;
  const second = f.make();
  second.registered(f.socket, { agentNotifications: { version: 1 } });
  await waitFor(() => expect(f.frames.length).toBeGreaterThan(0));
  expect(f.frames[0]).toEqual(original);
  f.ack(second, original, { readyState: 1 } as WebSocket);
  expect(f.saved().cursor.attention).toEqual([]);
  f.ack(second, original);
  await waitFor(() => expect(f.saved().pending).toBeUndefined());
});

test("timeout retries the same ID and never advances a partially acknowledged batch", async () => {
  const f = setup([entry("first"), entry("second")]), delivery = f.make(100);
  delivery.registered(f.socket, { agentNotifications: { version: 1 } });
  await waitFor(() => expect(f.frames.length).toBeGreaterThan(0));
  f.ack(delivery, f.frames[0]!);
  await waitFor(() => expect(f.frames.some(frame => frame.messageId === "second")).toBe(true));
  expect(f.saved().cursor.attention).toEqual([]);
  await waitFor(() => expect(f.frames.filter(frame => frame.messageId === "first").length).toBeGreaterThan(1));
  expect(new Set(f.frames.filter(frame => frame.messageId === "first").map(frame => frame.eventId)).size).toBe(1);
  await delivery.stop();
  expect(f.saved().pending?.entries).toHaveLength(2);
});

test("journal failure before dispatch does not lose the batch or send an unrecorded event", async () => {
  const f = setup([entry("safe")]);
  vi.mocked(f.store.write).mockRejectedValueOnce(new Error("disk unavailable"));
  const delivery = f.make();
  delivery.registered(f.socket, { agentNotifications: { version: 1 } });
  await waitFor(() => expect(f.errors).toHaveBeenCalled());
  expect(f.saved().cursor.attention).toEqual([]);
  await waitFor(() => expect(f.frames.length).toBeGreaterThan(0));
  expect(f.saved().pending?.entries[0]?.eventId).toBe(f.frames[0]?.eventId);
  f.ack(delivery, f.frames[0]!);
  await waitFor(() => expect(f.saved().pending).toBeUndefined());
});

test("expired pending delivery is discarded without a push and commits its cursor", async () => {
  const f = setup();
  await f.store.write({ version: 1, activatedAt: 0, cursor: emptyAgentNotificationCursor(), pending: {
    cursor: { attention: [{ agentId: "a", messages: 1, traces: 0 }], waits: [] },
    entries: [{ ...entry("expired", 1), expiresAt: 2_000 }],
  } });
  f.source.read.mockResolvedValue({ cursor: { attention: [{ agentId: "a", messages: 1, traces: 0 }], waits: [] }, entries: [] });
  const delivery = f.make();
  delivery.registered(f.socket, { agentNotifications: { version: 1 } });
  await waitFor(() => expect(f.saved().pending).toBeUndefined());
  expect(f.frames).toEqual([]);
  expect(f.saved().cursor.attention[0]?.messages).toBe(1);
});
