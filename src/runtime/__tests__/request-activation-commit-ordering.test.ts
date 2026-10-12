import type WebSocket from "ws";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fixture } from "../../sessions/request-lifecycle/__tests__/support.js";
import { createRuntimeEventBus } from "../events/runtime-emitter.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { RequestActivationEvents } from "../request/approval-wait/activation-events.js";
import { createSchedulerTestGate } from "./support/scheduler-runtime-fixture.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});

async function ownedFixture() {
  const f = await fixture();
  const published: Record<string, unknown>[] = [];
  const owner = new RequestActivationEvents(
    f.service.requestLifecycle,
    f.started.current,
    { create: createRuntimeEventBus },
    {
      send: (raw: string) => {
        published.push(JSON.parse(raw));
      },
    } as WebSocket,
  );
  return { ...f, owner, published };
}

test.each(["terminal", "wait"] as const)(
  "%s commit reserves the event queue; a later event cannot invalidate its revision",
  async (transition) => {
    const f = await ownedFixture();
    const entered = createSchedulerTestGate();
    const finish = createSchedulerTestGate();
    const append = vi.spyOn(
      f.service.requestLifecycle,
      "appendActivationEvent",
    );
    const committed = f.owner.commit(async (expected) => {
      entered.open();
      await finish.waiting;
      if (transition === "wait")
        return f.service.requestLifecycle.commitWait("conversation", {
          ...f.command,
          expected,
        });
      return f.service.requestLifecycle.commitTerminal("conversation", {
        expected,
        commandId: "terminal",
        status: "completed",
        message: { content: "Finished once." },
      });
    });
    try {
      await entered.waiting;
      f.owner.events.event("session.messages.updated", {
        sessionId: "conversation",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(append).not.toHaveBeenCalled();
    } finally {
      finish.open();
    }
    await expect(committed).resolves.toMatchObject({
      accepted: true,
      current: {
        status: transition === "wait" ? "awaiting_approval" : "completed",
      },
    });
    await f.owner.events.drain();
    expect(append).not.toHaveBeenCalled();
    expect(
      f.published.some((event) => event.name === "session.messages.updated"),
    ).toBe(false);
    const current = await f.service.requestLifecycle.get(
      "conversation",
      "request",
    );
    expect(current?.revision).toBe(f.owner.snapshot().revision);
    f.owner.events.dispose();
  },
);

test("events queued before a commit retain their committed sequence and revision", async () => {
  const f = await ownedFixture();
  f.owner.events.event("session.messages.updated", {
    sessionId: "conversation",
  });
  await f.owner.commit((expected) =>
    f.service.requestLifecycle.commitTerminal("conversation", {
      expected,
      commandId: "terminal",
      status: "completed",
      message: { content: "Finished after the event." },
    }),
  );
  expect(f.published[0]).toMatchObject({
    name: "session.messages.updated",
    eventSequence: 1,
  });
  expect(f.published.at(-1)).toMatchObject({ type: "completed" });
  const sequences = f.published.map((event) => Number(event.eventSequence));
  expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  f.owner.events.dispose();
});

test("failure sealing drains already queued events before committing the terminal", async () => {
  const f = await ownedFixture();
  f.owner.events.event("session.messages.updated", {
    sessionId: "conversation",
  });
  await f.owner.finalizeFailure({
    commandId: "failure",
    cause: "request_failed",
    error: "fixture_failure",
    message: { content: "Stopped safely." },
  });
  expect(f.published[0]).toMatchObject({
    name: "session.messages.updated",
    eventSequence: 1,
  });
  expect(f.published.at(-1)).toMatchObject({ type: "failed" });
  expect(f.owner.snapshot().status).toBe("failed");
  f.owner.events.dispose();
});

test("a nonterminal commit releases its new revision to the following event", async () => {
  const f = await ownedFixture();
  const entered = createSchedulerTestGate();
  const finish = createSchedulerTestGate();
  const committed = f.owner.commit(async (expected) => {
    entered.open();
    await finish.waiting;
    return f.service.requestLifecycle.appendActivationEvent("conversation", {
      expected,
      payload: { type: "event", name: "fixture.committed" },
    });
  });
  await entered.waiting;
  f.owner.events.event("session.messages.updated", {
    sessionId: "conversation",
  });
  finish.open();
  await committed;
  await f.owner.events.drain();
  expect(f.published.map((event) => event.name)).toEqual([
    "fixture.committed",
    "session.messages.updated",
  ]);
  expect(f.owner.snapshot()).toMatchObject({
    status: "streaming",
    revision: 2,
  });
  f.owner.events.dispose();
});

test("a lost activation fence rejects without refreshing or overwriting the committed terminal", async () => {
  const f = await ownedFixture();
  await f.service.requestLifecycle.commitTerminal("conversation", {
    expected: {
      requestId: f.started.current.requestId,
      generation: f.started.current.generation,
      revision: f.started.current.revision,
      ...f.started.current.activation!,
    },
    commandId: "other-terminal",
    status: "completed",
    message: { content: "Authoritative terminal." },
  });
  await expect(
    f.owner.commit((expected) =>
      f.service.requestLifecycle.commitTerminal("conversation", {
        expected,
        commandId: "stale-terminal",
        status: "completed",
        message: { content: "Must not persist." },
      }),
    ),
  ).rejects.toThrow("request_lifecycle_rejected:");
  await expect(
    f.owner.finalizeFailure({
      commandId: "failure",
      cause: "request_failed",
      error: "stale_commit",
      message: { content: "Must not replace the answer." },
    }),
  ).resolves.toMatchObject({ status: "completed" });
  const session = await f.service.getSessionById("conversation");
  expect(
    session!.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content),
  ).toEqual(["Authoritative terminal."]);
  expect(f.published).toEqual([]);
  f.owner.events.dispose();
});
