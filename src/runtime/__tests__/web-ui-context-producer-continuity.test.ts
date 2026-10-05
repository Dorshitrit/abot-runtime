import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionService } from "../../sessions/session-service.js";
import { createRealtimeTransport } from "../../web-ui/app/services/realtime-transport.js";
import type { ContextWindowState } from "../../web-ui/app/lib/context-window-state.js";
import { createRuntimeEventBus } from "../events/runtime-emitter.js";
import { RequestActivationEvents } from "../request/approval-wait/activation-events.js";
import { createPersistentRequestEvents } from "../streaming/request-callbacks.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function wire() {
  let receive: (message: Record<string, unknown>) => void = () => {};
  const received: Record<string, unknown>[] = [];
  const emitted: Record<string, unknown>[] = [];
  class BrowserSocket {
    static OPEN = 1;
    static current: BrowserSocket;
    readyState = BrowserSocket.OPEN;
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor() {
      BrowserSocket.current = this;
    }
    addEventListener(
      name: string,
      listener: (event: { data: string }) => void,
    ) {
      this.listeners.set(name, listener);
    }
    send() {}
  }
  const parseError = vi.fn();
  const transport = createRealtimeTransport({
    getConfig: () => ({ realtimePath: "/realtime" }),
    onMessage: (message) => {
      received.push(message);
      receive(message);
    },
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    onParseError: parseError,
    WebSocketImpl: BrowserSocket as never,
    location: { protocol: "http:", host: "localhost" } as Location,
    scheduleReconnect: vi.fn() as never,
  });
  transport.connect();
  const ws = {
    send(data: string) {
      const payload = {
        ...JSON.parse(data),
        environment: "dev",
        sessionId: "session-1",
      };
      emitted.push(payload);
      BrowserSocket.current.listeners.get("message")?.({
        data: JSON.stringify(payload),
      });
    },
  } as WebSocket;
  return {
    ws,
    emitted,
    transport,
    attach: (handler: typeof receive) => {
      receive = handler;
    },
    async settled() {
      await vi.waitFor(() => expect(received).toHaveLength(emitted.length));
      expect(parseError).not.toHaveBeenCalled();
    },
  };
}

async function fixture(durable: boolean) {
  const artifactRoot = join(
    process.cwd(),
    ".codex/artifacts/web-ui-context-producer-continuity",
  );
  await mkdir(artifactRoot, { recursive: true });
  const sessionsDir = await mkdtemp(join(artifactRoot, "ui-producer-"));
  directories.push(sessionsDir);
  const store = new SessionService({ sessionsDir });
  await store.appendMessage(
    "session-1",
    "user",
    "Continue the current request.",
    { requestId: "request-1" },
  );
  const channel = wire();
  const factory = { create: createRuntimeEventBus };
  if (!durable) {
    await store.startRequestStream("session-1", "request-1");
    const events = createPersistentRequestEvents({
      currentEvents: factory.create({ requestId: "request-1", ws: channel.ws }),
      eventSinkFactory: factory,
      requestId: "request-1",
      sessionId: "session-1",
      sessionStore: store,
      ws: channel.ws,
    });
    return { store, channel, events, generation: "" };
  }
  const started = await store.requestLifecycle.startActivation("session-1", {
    requestId: "request-1",
    activationId: "activation-1",
    ownerEpoch: "owner-1",
  });
  expect(started.accepted).toBe(true);
  if (!started.accepted) throw new Error(started.reason);
  const owner = new RequestActivationEvents(
    store.requestLifecycle,
    started.current,
    factory,
    channel.ws,
  );
  return {
    store,
    channel,
    events: owner.events,
    generation: started.current.generation,
  };
}

const snapshot = (invocationId: string, measuredInputTokens: number) => ({
  invocationId,
  modelStep: "execution.decision",
  profileId: "luna",
  admissionOutcome: "accepted",
  measuredInputTokens,
  estimatedInputTokens: 52418,
  contextWindowTokens: 32000,
});

describe("actual context event producers across reload", () => {
  test.each([true, false])(
    "the final producer advances restored metric, usage and cycles (durable=%s)",
    async (durable) => {
      const f = await fixture(durable);
      const fresh = createPlanLifecycleHarness();
      f.channel.attach((message) => fresh.realtime.handle(message));
      expect(fresh.state.requestLifecycles?.size ?? 0).toBe(0);
      f.events.event(
        "context.window.snapshot",
        snapshot("before-reload", 21292),
      );
      await f.events.drain();
      await f.channel.settled();
      expect(
        (
          fresh.state.contextWindowByRequest.get("request-1") as
            | ContextWindowState
            | undefined
        )?.snapshot,
      ).toMatchObject({ inputTokens: 21292, generation: f.generation });
      const payload = await f.store.getSessionSnapshot("session-1");
      expect(payload).not.toBeNull();
      const h = createPlanLifecycleHarness(
        payload as unknown as Record<string, unknown>,
      );
      await h.conversationSession.openSession("session-1");
      const context = () =>
        h.state.contextWindowByRequest.get("request-1") as ContextWindowState;
      expect(context().snapshot).toMatchObject({
        inputTokens: 21292,
        generation: f.generation,
      });
      if (durable)
        expect(payload?.requests[0]?.lifecycle?.generation).toBe(f.generation);
      else {
        expect(payload?.requests[0]?.lifecycle).toBeUndefined();
        const stored = await f.store.getSessionById("session-1");
        expect(stored?.requests?.[0]?.generation).toEqual(expect.any(String));
      }

      f.channel.attach((message) => h.realtime.handle(message));
      f.channel.transport.connect();
      f.events.event("context.window.snapshot", snapshot("live", 16000));
      f.events.event("context.window.provider_usage", {
        invocationId: "live",
        inputTokens: 16000,
        outputTokens: 42,
      });
      f.events.event("context.compaction.started", {
        invocationId: "outer",
        modelStep: "execution.decision",
        profileId: "luna",
      });
      await f.events.drain();
      await f.channel.settled();
      expect(context().snapshot).toMatchObject({
        invocationId: "live",
        inputTokens: 16000,
        usedContextPercent: 50,
      });
      expect(context().providerUsage).toMatchObject({
        invocationId: "live",
        inputTokens: 16000,
        outputTokens: 42,
      });
      expect(context().pendingCompaction?.invocationId).toBe("outer");

      f.events.event("context.compaction.completed", {
        invocationId: "outer",
        modelStep: "execution.decision",
        profileId: "luna",
        beforeInputTokens: 24000,
        afterInputTokens: 8000,
        contextWindowTokens: 32000,
      });
      await f.events.drain();
      await f.channel.settled();
      expect(context().pendingCompaction).toBeNull();
      expect(context().lastCompaction).toMatchObject({
        invocationId: "outer",
        beforePercent: 75,
        afterPercent: 25,
      });
      for (const event of f.channel.emitted) {
        expect(event.generation).toBe(durable ? f.generation : undefined);
        if (durable)
          expect(event).toMatchObject({
            sessionId: "session-1",
            activationId: "activation-1",
          });
      }
    },
  );
});
