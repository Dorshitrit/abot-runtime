import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import {
  accepted,
  activationExpected,
  fixture,
} from "../../sessions/request-lifecycle/__tests__/support.js";
import { createRuntimeEventBus } from "../events/runtime-emitter.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { RequestActivationEvents } from "../request/approval-wait/activation-events.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  vi.restoreAllMocks();
  resetDebugLoggerConfig();
});
const terminal = {
  content: "Unable to finish; continue in a new request.",
  grounding: "conversation" as const,
};
const failed = {
  commandId: "failure",
  cause: "request_failed" as const,
  message: terminal,
  error: "primary_failure",
};

async function ownedFixture() {
  const f = await fixture();
  const published: Record<string, unknown>[] = [];
  const ws = {
    send: (data: string) => published.push(JSON.parse(data)),
  } as unknown as WebSocket;
  const owner = new RequestActivationEvents(
    f.service.requestLifecycle,
    f.started.current,
    { create: createRuntimeEventBus },
    ws,
  );
  return { ...f, owner, published, ws };
}

test.each(["waiting", "terminal", "foreign"] as const)(
  "durable %s state is checked before explanation authoring",
  async (state) => {
    const f = await ownedFixture();
    if (state === "waiting")
      accepted(
        await f.service.requestLifecycle.commitWait("conversation", f.command),
      );
    if (state === "terminal")
      accepted(
        await f.service.requestLifecycle.commitTerminal("conversation", {
          expected: activationExpected(f.started.current),
          commandId: "existing-terminal",
          status: "completed",
          message: { content: "Existing answer" },
        }),
      );
    if (state === "foreign")
      vi.spyOn(f.service.requestLifecycle, "get").mockResolvedValue({
        ...f.started.current,
        activation: { activationId: "another", ownerEpoch: "another" },
      });
    const prepareFailure = vi.fn(async () => failed);
    const current = await f.owner.finalizeFailure({
      ...failed,
      prepareFailure,
    });
    expect(prepareFailure).not.toHaveBeenCalled();
    expect(current.status).toBe(
      state === "waiting"
        ? "awaiting_approval"
        : state === "terminal"
          ? "completed"
          : "streaming",
    );
    expect(f.published).toEqual([]);
    f.owner.events.dispose();
  },
);

test("durable explanation persists once before failed-event publication; repeated failure does not author again", async () => {
  const f = await ownedFixture();
  const prepareFailure = vi.fn(async () => failed);
  const append = vi.spyOn(f.service.requestLifecycle, "commitTerminal");
  await f.owner.finalizeFailure({ ...failed, prepareFailure });
  await f.owner.finalizeFailure({
    ...failed,
    commandId: "later-failure",
    prepareFailure,
  });
  expect(prepareFailure).toHaveBeenCalledOnce();
  expect(append).toHaveBeenCalledOnce();
  expect(f.published.filter(({ type }) => type === "failed")).toHaveLength(1);
  const session = await f.service.getSessionById("conversation");
  expect(session?.messages.filter(({ role }) => role === "assistant")).toEqual([
    expect.objectContaining({ content: terminal.content }),
  ]);
  expect(
    await f.service.requestLifecycle.get("conversation", "request"),
  ).toMatchObject({ status: "failed", terminalCause: "request_failed" });
  f.owner.events.dispose();
});

test("durable CAS rejects stale finalization when another terminal commits during authoring", async () => {
  const f = await ownedFixture();
  const prepareFailure = vi.fn(async () => {
    accepted(
      await f.service.requestLifecycle.interruptActivation("conversation", {
        expected: activationExpected(f.started.current),
        commandId: "interrupt",
        message: { content: "Stopped by runtime." },
      }),
    );
    return failed;
  });
  await expect(
    f.owner.finalizeFailure({ ...failed, prepareFailure }),
  ).rejects.toThrow("request_lifecycle_rejected");
  expect(prepareFailure).toHaveBeenCalledOnce();
  const session = await f.service.getSessionById("conversation");
  expect(session?.messages.filter(({ role }) => role === "assistant")).toEqual([
    expect.objectContaining({ content: "Stopped by runtime." }),
  ]);
  expect(f.published).toEqual([]);
  f.owner.events.dispose();
});

test("cancellation that arrives during authoring retains its latest terminal cause", async () => {
  const f = await ownedFixture();
  await f.owner.finalizeFailure({
    ...failed,
    prepareFailure: async () => ({
      cause: "request_cancelled",
      error: "request_cancelled",
      message: { content: "I stopped the task at your request." },
    }),
  });
  expect(
    await f.service.requestLifecycle.get("conversation", "request"),
  ).toMatchObject({ status: "failed", terminalCause: "request_cancelled" });
  f.owner.events.dispose();
});

test("committed transport failure cannot repeat durable authoring or persistence", async () => {
  const f = await ownedFixture();
  vi.spyOn(f.ws, "send").mockImplementation(() => {
    throw new Error("transport_failed");
  });
  const prepareFailure = vi.fn(async () => failed);
  await expect(
    f.owner.finalizeFailure({ ...failed, prepareFailure }),
  ).resolves.toMatchObject({ status: "failed" });
  await expect(
    f.owner.finalizeFailure({ ...failed, commandId: "repeat", prepareFailure }),
  ).resolves.toMatchObject({ status: "failed" });
  expect(prepareFailure).toHaveBeenCalledOnce();
  const session = await f.service.getSessionById("conversation");
  expect(
    session?.messages.filter(({ role }) => role === "assistant"),
  ).toHaveLength(1);
  f.owner.events.dispose();
});
