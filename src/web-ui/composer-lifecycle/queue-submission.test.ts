import { afterEach, expect, test, vi } from "vitest";
import { composerHttpFixture } from "./__tests__/composer-http-fixture.js";
import { deferred } from "./__tests__/composer-product-fixture.js";

const fixtures: Array<Awaited<ReturnType<typeof composerHttpFixture>>> = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.close())); vi.unstubAllGlobals(); });
async function fixture(options: Parameters<typeof composerHttpFixture>[0] = {}) {
  const f = await composerHttpFixture(options); fixtures.push(f); return f;
}
const scope = { environmentId: "prod", sessionId: "chat-1" };
async function enqueue(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  f.state.activeRequestId = "old";
  f.type(text);
  expect((await f.composer.submit.dispatch("send_next")).status).toBe("accepted");
}

test("new conversations render and assign a scope before sending", async () => {
  const f = await fixture();
  expect(() => f.switchSession("")).not.toThrow();
  expect(f.composer.queue.queuedCount()).toBe(0);
  f.type("New conversation");
  expect((await f.composer.submit.dispatch()).status).toBe("accepted");
  expect(f.messages).toEqual([expect.objectContaining({ text: "New conversation", sessionId: "new-chat" })]);
});

test("a rejected queued POST returns ownership to editing before a manual retry", async () => {
  let refuse = true;
  const f = await fixture({ chat: async () => refuse
    ? Response.json({ error: "model_invalid", message: "Choose a model" }, { status: 400 })
    : Response.json({ requestId: "retry" }) });
  await enqueue(f, "Queued instruction");
  f.state.activeRequestId = "";
  await f.composer.queue.drain({ ...scope, terminalRequestId: "old" });
  expect(f.workspace.chatDraft().text).toBe("Queued instruction");
  expect(f.queueStore.getBlockedRelease(scope).owner.state).toBe("editing");
  refuse = false;
  expect((await f.composer.submit.dispatch()).status).toBe("accepted");
  expect(f.messages).toHaveLength(2);
  expect(f.queueStore.getBlockedRelease(scope)).toBeNull();
});

test("terminal during a held binding ACK releases the next item only after ACK, once", async () => {
  const bound = deferred();
  const f = await fixture({ afterMutation: async (input) => {
    if (input.action === "bind" && input.requestId === "accepted-1") await bound.promise;
  } });
  await enqueue(f, "First");
  await enqueue(f, "Second");
  f.state.activeRequestId = "";
  const activate = f.session.activateRequestForScope;
  f.session.activateRequestForScope = (target, requestId) => {
    activate(target, requestId);
    if (requestId !== "accepted-1") return;
    f.state.activeRequestId = "";
    void f.composer.queue.drain({ ...scope, terminalRequestId: requestId });
    void f.composer.queue.drain({ ...scope, terminalRequestId: requestId });
  };
  const draining = f.composer.queue.drain({ ...scope, terminalRequestId: "old" });
  await vi.waitFor(() => expect(f.activated).toEqual(["accepted-1"]));
  expect(f.messages).toHaveLength(1);
  bound.resolve();
  await draining;
  expect(f.messages.map((message) => message.text)).toEqual(["First", "Second"]);
  expect(f.queueStore.getBlockedRelease(scope)).toBeNull();
});

test("failure of a preference key neither poisons queue ACKs nor normal sends", async () => {
  const f = await fixture({ beforeMutation: async (input) => input.kind === "preference"
    ? Response.json({ message: "Preference conflict" }, { status: 409 }) : undefined });
  await expect(f.storage.setItem("abot-web.pinnedSessions", '["pin"]')).rejects.toThrow("Preference conflict");
  await enqueue(f, "Unaffected queue");
  f.state.activeRequestId = "";
  await f.composer.queue.drain({ ...scope, terminalRequestId: "old" });
  expect(f.messages.map((message) => message.text)).toEqual(["Unaffected queue"]);
  expect(f.storage.getItem("abot-web.pinnedSessions")).toBeNull();
  expect(f.storage.error().message).toBe("Preference conflict");
});

test("two windows observing one terminal cannot POST the same queued item twice", async () => {
  const first = await fixture();
  const second = await first.anotherWindow();
  await enqueue(first, "Once");
  first.state.activeRequestId = "";
  await second.storage.refresh();
  await Promise.all([first, second].map((f) => f.composer.queue.drain({ ...scope, terminalRequestId: "old" })));
  expect(first.messages.map((message) => message.text)).toEqual(["Once"]);
});

test("a manually recovered lease cannot silently become Steer or a duplicate queue item", async () => {
  let refuse = true;
  const f = await fixture({ chat: async () => refuse
    ? Response.json({ message: "Unknown outcome" }, { status: 503 }) : Response.json({ requestId: "new" }) });
  await enqueue(f, "Unconfirmed queued item");
  f.state.activeRequestId = "";
  await f.composer.queue.drain({ ...scope, terminalRequestId: "old" });
  const attempt = f.composer.lifecycle.paused(scope)[0];
  expect(attempt).toBeTruthy();
  refuse = false;
  f.type("Independent new input");
  expect((await f.composer.submit.dispatch()).status).toBe("accepted");
  await f.composer.lifecycle.restoreForManualReview(attempt.id, f.composer.queue.authorizeReview);
  expect((await f.composer.submit.dispatch("send_next")).status).toBe("refused");
  expect(f.workspace.chatDraft().text).toBe("Unconfirmed queued item");
  expect(f.queueStore.list(scope)).toHaveLength(0);
  expect(f.queueStore.getBlockedRelease(scope)).not.toBeNull();
  expect(f.messages).toHaveLength(2);
  expect(f.statuses.at(-1)).toContain("Wait for the active request");
});
