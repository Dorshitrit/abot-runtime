import { expect, test } from "vitest";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

const target = {
  messages: [{ id: "old", role: "assistant", text: "Older answer", requestId: "old-run", createdAt: 1 }],
  requests: [], nextCursor: "older", newerCursor: "newer",
};
const latest = { messages: [{ id: "latest", role: "assistant", text: "Latest answer", requestId: "latest-run" }], requests: [], nextCursor: "latest-older", newerCursor: null };

test.each(["network_error", "history_cursor_stale"])("Latest failure (%s) preserves the visible history and cursors", async (code) => {
  const f = createPlanLifecycleHarness(target);
  await f.conversationSession.openSession("session-1");
  const before = { messages: f.state.messages, events: f.state.events, version: f.state.sessionViewVersion };
  f.clearPendingAttachments.mockClear();
  const failure = Object.assign(new Error(code), { code });
  f.client.loadSession.mockRejectedValueOnce(failure);
  await expect(f.conversationSession.history.latest()).rejects.toBe(failure);
  expect(f.state.messages).toBe(before.messages);
  expect(f.state.events).toBe(before.events);
  expect(f.state.sessionViewVersion).toBe(before.version);
  expect(f.clearPendingAttachments).not.toHaveBeenCalled();
  expect(f.conversationSession.history.hasNewer()).toBe(true);
  f.client.loadSession.mockResolvedValueOnce({ messages: [], requests: [], nextCursor: null });
  await f.conversationSession.history.load("older");
  expect(f.client.loadSession).toHaveBeenLastCalledWith("session-1", "dev", { cursor: "older" });
  f.client.loadSession.mockResolvedValueOnce(latest);
  await f.conversationSession.history.latest();
  expect(f.state.messages.map((message) => message.id)).toEqual(["latest"]);
  expect(f.conversationSession.history.hasNewer()).toBe(false);
});

test.each(["same view", "environment", "session"])("Latest commits only after success in the %s", async (change) => {
  let environmentId = "dev";
  const f = createPlanLifecycleHarness(target, [], () => environmentId);
  await f.conversationSession.openSession("session-1");
  const previousMessages = f.state.messages;
  let finish!: (snapshot: Record<string, unknown>) => void;
  f.client.loadSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const opening = f.conversationSession.history.latest();
  expect(f.state.messages).toBe(previousMessages);
  expect(f.conversationSession.history.hasNewer()).toBe(true);
  if (change === "environment") environmentId = "prod";
  if (change === "session") await f.conversationSession.openSession("session-2");
  const currentMessages = f.state.messages;
  finish(latest);
  await opening;
  if (change === "same view") {
    expect(f.state.messages.map((message) => message.id)).toEqual(["latest"]);
    expect(f.conversationSession.history.hasNewer()).toBe(false);
  } else expect(f.state.messages).toBe(currentMessages);
});
