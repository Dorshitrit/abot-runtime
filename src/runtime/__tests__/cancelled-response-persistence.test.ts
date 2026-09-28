import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import {
  configureDebugLogger,
  resetDebugLoggerConfig,
} from "../observability/debug-logger.js";
import { persistCancelledResponse } from "../session/cancelled-response.js";
import { createSessionLifecycleStore } from "../session/session-lifecycle-store.js";
import { snapshotSessionMemorySource } from "../../sessions/memory/source.js";

beforeEach(() => configureDebugLogger({ enabled: false }));
afterEach(() => {
  resetDebugLoggerConfig();
  vi.restoreAllMocks();
});

test("cancellation preserves only its request's user messages and visible answer", async () => {
  const sessionStore = createInMemorySessionStore();
  await sessionStore.getOrCreateSession("session");
  await sessionStore.appendMessage("session", "user", "Older unpaired request", {
    requestId: "other",
  });
  const params = {
    sessionStore,
    sessionId: "session",
    requestId: "cancelled",
    partialAnswer: "Observed partial answer.",
  };
  // Opening a stream alone is not a reason to invent an assistant turn.
  expect(await persistCancelledResponse(params)).toEqual({});
  await sessionStore.appendMessage("session", "user", "Original request", {
    requestId: "cancelled",
  });
  await sessionStore.appendMessage("session", "user", "Steering update", {
    requestId: "cancelled",
  });
  const result = await persistCancelledResponse(params);
  expect(result.stoppedResponse).toMatch(/^Observed partial answer\./);
  const appendMessage = vi.spyOn(sessionStore, "appendMessage");
  expect(await persistCancelledResponse(params)).toEqual(result);
  expect(appendMessage).not.toHaveBeenCalled();
  const session = await sessionStore.getSessionById("session");
  expect(session?.messages.filter((message) => message.role === "assistant")).toEqual([
    expect.objectContaining({ requestId: "cancelled", content: result.stoppedResponse }),
  ]);
  const { turns } = snapshotSessionMemorySource(session!);
  expect(turns).toHaveLength(1);
  expect(turns[0]?.userMessages.map((message) => message.content)).toEqual([
    "Original request", "Steering update",
  ]);
});

test("cancellation cannot recreate a deleted session", async () => {
  const sessionStore = createSessionLifecycleStore(
    createInMemorySessionStore(),
  ).store;
  await sessionStore.getOrCreateSession("session");
  await sessionStore.appendMessage("session", "user", "Original request", {
    requestId: "cancelled",
  });
  await sessionStore.deleteSession("session");
  expect(await persistCancelledResponse({
    sessionStore, sessionId: "session", requestId: "cancelled", partialAnswer: "",
  })).toEqual({ stoppedResponsePersistenceFailed: true });
  expect(await sessionStore.getSessionById("session")).toBeNull();
});
