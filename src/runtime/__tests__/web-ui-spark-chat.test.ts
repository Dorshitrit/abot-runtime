import { describe, expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
// @ts-expect-error Browser workflow module.
import { visibleSparkMessageIds } from "../../web-ui/app/controllers/spark-chat-reading.js";
// @ts-expect-error Browser workflow module.
import { createSparkChatNotices } from "../../web-ui/app/controllers/spark-chat-notices.js";
// @ts-expect-error Browser workflow module.
import { createSparkChatSync, mergeSparkSnapshotMessages } from "../../web-ui/app/controllers/spark-chat-sync.js";
// @ts-expect-error Browser projection module.
import { reconcileSparkReadState } from "../../web-ui/app/lib/spark-chat-read-state.js";
// @ts-expect-error Browser projection module.
import { ownsToolApprovalAcknowledgement } from "../../web-ui/app/lib/tool-approval-acknowledgement.js";
// @ts-expect-error Browser projection module.
import { canRestoreSparkAddress, resolveSparkMessageTarget, sparkNotificationReference } from "../../web-ui/app/lib/spark-chat-address.js";

const assistant = (id: string, text = id) => ({ id, persistedMessageId: id, role: "assistant", text, streaming: false });
const readState = (ids: string[]) => ({ unreadMessageIds: ids, unreadCount: ids.length, readRevision: 1, readGeneration: "generation-one" });

describe("SPARK exact visibility", () => {
  test("an unavailable linked environment cannot open a same-id message in the fallback environment", () => {
    const address = new URL("https://abot.test/home?environment=removed-dev&spark=1&message=1");
    expect(canRestoreSparkAddress(address, "prod")).toBe(false);
    expect(canRestoreSparkAddress(address, "removed-dev")).toBe(true);
  });
  test("an old notification cannot target a new message that reused its cleared ID", () => {
    const address = new URL("https://abot.test/home?environment=dev&spark=1&message=2&messageCreatedAt=100&request=old");
    const reference = sparkNotificationReference(address);
    expect(resolveSparkMessageTarget([{ id: 2, createdAt: 100, requestId: "new" }], "2", reference)).toBeUndefined();
    expect(resolveSparkMessageTarget([{ id: 2, createdAt: 200, requestId: "old" }], "2", reference)).toBeUndefined();
    expect(resolveSparkMessageTarget([{ id: 2, createdAt: 100, requestId: "old" }], "2", reference)).toBe("2");
    expect(resolveSparkMessageTarget([{ id: 2 }], "2", null)).toBeUndefined();
  });
  test("approval acknowledgements affect only their submitting conversation and environment", () => {
    const state = { currentSessionId: "ordinary", submittedToolApprovalIds: new Set(["ordinary-approval"]) };
    expect(ownsToolApprovalAcknowledgement({ approvalId: "spark-approval", sessionId: "spark" }, state, "dev")).toBe(false);
    expect(ownsToolApprovalAcknowledgement({ approvalId: "ordinary-approval", environment: "prod" }, state, "dev")).toBe(false);
    expect(ownsToolApprovalAcknowledgement({ approvalId: "ordinary-approval", environment: "dev", sessionId: "ordinary" }, state, "dev")).toBe(true);
  });
  test("a delayed read receipt retains messages that arrived after visibility was captured", () => {
    const current = readState(["first", "new"]);
    const next = reconcileSparkReadState(current, { ...readState([]), readRevision: 2 }, { observedUnreadIds: ["first"], acknowledgedIds: ["first"] });
    expect(next.unreadMessageIds).toEqual(["new"]);
    expect(next.unreadCount).toBe(1);
  });
  test("a receipt from a cleared conversation cannot replace the new unread generation", () => {
    const current = { ...readState(["reused-id"]), readGeneration: "new-generation" };
    expect(reconcileSparkReadState(current, { ...readState([]), readRevision: 99 }, { observedUnreadIds: ["reused-id"] })).toBe(current);
  });
  test("unavailable read tracking preserves the last known count without inventing a clear", () => {
    const current = readState(["one"]);
    expect(reconcileSparkReadState(current, { readStateStatus: "unavailable", unreadCount: null })).toMatchObject({ unreadMessageIds: ["one"], unreadCount: 1, readGeneration: "generation-one", readStateStatus: "unavailable" });
  });
  test("long visible head is read while offscreen, streaming and user rows remain unread", () => {
    const messages = [assistant("long"), assistant("below"), { ...assistant("stream"), streaming: true }, { ...assistant("user"), role: "user" }];
    const rows = [
      { id: "long", top: 100, bottom: 1500 }, { id: "below", top: 1600, bottom: 1700 },
      { id: "stream", top: 110, bottom: 160 }, { id: "user", top: 170, bottom: 180 },
    ];
    expect(visibleSparkMessageIds({ messages, rows, bounds: { top: 100, bottom: 500 } })).toEqual(["long"]);
  });
  test("scrolling past an unseen message acknowledges only actual visible rows", () => {
    expect(visibleSparkMessageIds({
      messages: [assistant("first"), assistant("second"), assistant("third")],
      rows: [{ id: "first", top: -200, bottom: -100 }, { id: "second", top: -80, bottom: 0 }, { id: "third", top: 20, bottom: 80 }],
      bounds: { top: 0, bottom: 100 },
    })).toEqual(["third"]);
  });
  test("transport binds explicit IDs to read generation and environment", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true })));
    const client = createRuntimeWebClient({ getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => "dev one", fetchImpl, origin: "http://localhost" });
    const visibleMessages = [{ id: "initiative:one", createdAt: 100, requestId: null }, { id: 3, createdAt: 150, requestId: "r" }];
    await client.markSparkMessagesRead({ visibleMessageIds: ["initiative:one", 3], visibleMessages, readGeneration: "before-clear" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("/web-api/runtime/spark/chat/read?environment=dev+one");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toEqual({ visibleMessageIds: ["initiative:one", 3], visibleMessages, readGeneration: "before-clear" });
  });
});

describe("SPARK new-message notices", () => {
  test("hidden approval presentations do not generate message previews", () => {
    const showNotice = vi.fn();
    const notices = createSparkChatNotices({ showNotice, setUnread: vi.fn(), isVisible: () => true });
    notices.reconcile({ messages: [] }, readState([]));
    const approval = { ...assistant("approval"), kind: "tool_approval_request" };
    notices.reconcile({ messages: [approval] }, readState([]));
    expect(showNotice).not.toHaveBeenCalled();
    notices.reconcile({ messages: [approval, assistant("reply", "Your answer")] }, readState(["reply"]));
    expect(showNotice).toHaveBeenCalledExactlyOnceWith("Your answer");
  });
  test("a new request with reused ID and timestamp still raises a new notice", () => {
    const showNotice = vi.fn();
    const notices = createSparkChatNotices({ showNotice, setUnread: vi.fn(), isVisible: () => true });
    notices.reconcile({ messages: [{ ...assistant("1"), createdAt: 100, requestId: "old" }] }, readState(["1"]));
    notices.reconcile({ messages: [{ ...assistant("1", "New response"), createdAt: 100, requestId: "new" }] }, readState(["1"]));
    expect(showNotice).toHaveBeenLastCalledWith("New response");
  });
  test("consolidates seven restored messages, deduplicates replay, then shows model text", () => {
    const showNotice = vi.fn();
    const notices = createSparkChatNotices({ showNotice, setUnread: vi.fn(), isVisible: () => true });
    const messages = Array.from({ length: 7 }, (_, index) => assistant(String(index)));
    notices.reconcile({ messages }, readState(messages.map((item) => item.id)));
    expect(showNotice.mock.calls).toEqual([["7 unread messages"]]);
    notices.reconcile({ messages }, readState(messages.map((item) => item.id)));
    expect(showNotice).toHaveBeenCalledTimes(1);
    notices.reconcile({ messages: [...messages, assistant("result", "Your document is ready")] }, readState(["result"]));
    expect(showNotice).toHaveBeenLastCalledWith("Your document is ready");
  });
  test("hidden-page deliveries reconcile once on return", () => {
    let visible = true;
    const showNotice = vi.fn();
    const notices = createSparkChatNotices({ showNotice, setUnread: vi.fn(), isVisible: () => visible });
    notices.reconcile({ messages: [] }, readState([]));
    visible = false;
    notices.reconcile({ messages: [assistant("one"), assistant("two")] }, readState(["one", "two"]));
    expect(showNotice).not.toHaveBeenCalled();
    visible = true;
    notices.reconcile({ messages: [assistant("one"), assistant("two")] }, readState(["one", "two"]), { consolidated: true });
    expect(showNotice.mock.calls).toEqual([["2 unread messages"]]);
  });
});

function syncHarness() {
  let environment = "dev";
  const state = { messages: [], currentSessionId: "spark", composerSending: false, activeRequestId: "", requestMessages: new Map(), requestLifecycles: new Map() };
  const result = { sessionId: "spark", modelProfileId: "spark-model", snapshot: { messages: [assistant("a")], requests: [] }, readState: readState(["a"]) };
  const client = { loadSparkChat: vi.fn(async () => result), listModels: vi.fn(async () => ({ profiles: [{ id: "spark-model" }] })) };
  const conversation = { state, session: { openSession: vi.fn(async () => {}) }, render: vi.fn(), update: vi.fn() };
  const onConfiguration = vi.fn();
  const controller = createSparkChatSync({ client, getEnvironmentId: () => environment, conversation, onConfiguration, onReadState: vi.fn(), onSnapshot: vi.fn(), onError: vi.fn(), isAvailable: () => true });
  return { state, result, client, conversation, onConfiguration, controller, setEnvironment: (value: string) => { environment = value; } };
}

describe("SPARK durable reconciliation", () => {
  test.each([["openai-chatgpt", true], ["openai", false], [undefined, false]])("projects ChatGPT plan usage only from provider %s", async (provider, expected) => {
    const h = syncHarness();
    h.client.listModels.mockResolvedValue({ profiles: [{ id: "spark-model", ...{ provider, label: "ChatGPT" } }] });
    await h.controller.refresh({ wait: true });
    expect(h.onConfiguration).toHaveBeenCalledWith(expect.objectContaining({ usingChatgptPlan: expected }));
    expect(h.client.listModels).toHaveBeenCalledTimes(1);
  });

  test("hydrates once then refreshes messages without reopening the session or touching a composer draft", async () => {
    const h = syncHarness();
    await h.controller.refresh({ wait: true });
    await h.controller.refresh({ wait: true });
    expect(h.conversation.session.openSession).toHaveBeenCalledTimes(1);
    expect(h.conversation.render).toHaveBeenCalledTimes(1);
    expect(h.state.messages).toEqual([expect.objectContaining({ id: "a" })]);
  });
  test("defers snapshot replacement until a submitted message is acknowledged", async () => {
    const h = syncHarness(); h.state.composerSending = true;
    const pending = h.controller.refresh({ wait: true });
    expect(h.client.loadSparkChat).not.toHaveBeenCalled();
    h.state.composerSending = false; h.controller.composerChanged(false);
    await pending;
    expect(h.client.loadSparkChat).toHaveBeenCalledTimes(1);
  });
  test("reconnection hydrates the ordinary replay and approval lifecycle again", async () => {
    const h = syncHarness();
    await h.controller.refresh({ wait: true });
    await h.controller.refresh({ wait: true, rehydrate: true, consolidated: true });
    expect(h.conversation.session.openSession).toHaveBeenCalledTimes(2);
  });
  test("a snapshot already in flight cannot replace a newly submitted message", async () => {
    const h = syncHarness();
    let resolve!: (value: typeof h.result) => void;
    h.client.loadSparkChat.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = h.controller.refresh({ wait: true });
    h.state.composerSending = true;
    resolve(h.result);
    await vi.waitFor(() => expect(h.client.listModels).toHaveBeenCalledTimes(1));
    expect(h.onConfiguration).not.toHaveBeenCalled();
    h.state.composerSending = false;
    h.state.activeRequestId = "new-request";
    h.controller.composerChanged(false);
    await pending;
    expect(h.client.loadSparkChat).toHaveBeenCalledTimes(2);
    expect(h.onConfiguration).toHaveBeenCalledTimes(1);
  });
  test("environment switch settles old in-flight waiters and ignores their snapshots", async () => {
    const h = syncHarness();
    let resolve!: (value: typeof h.result) => void;
    h.client.loadSparkChat.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const old = h.controller.refresh({ wait: true });
    h.setEnvironment("prod"); h.controller.reset();
    const current = h.controller.refresh({ wait: true });
    resolve(h.result);
    await old; await current;
    expect(h.onConfiguration).toHaveBeenCalledTimes(1);
    expect(h.client.loadSparkChat.mock.calls).toEqual([["dev"], ["prod"]]);
  });
  test("canonical completion replaces the streaming placeholder without duplicating the message", () => {
    const messages = mergeSparkSnapshotMessages({ messages: [{ ...assistant("saved"), requestId: "r" }] }, [{ id: "assistant-r", role: "assistant", requestId: "r", text: "Streaming", streaming: true }]);
    expect(messages).toHaveLength(1); expect(messages[0].id).toBe("saved");
  });
});
