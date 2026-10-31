import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser workflow module.
import { createSparkChatSync, mergeSparkSnapshotMessages } from "../../web-ui/app/controllers/spark-chat-sync.js";
import { projectApprovalContinuations } from "../../web-ui/app/lib/request-lifecycle-view.js";
import { projectUserInteractionEvent } from "../../web-ui/app/lib/user-interaction-event.js";

type Message = { id: string; role: string; requestId: string; text: string; createdAt: string; kind?: string; streaming?: boolean; persistedMessageId?: string };
const at = (second: number) => "2026-10-27T12:00:" + String(second).padStart(2, "0") + ".000Z";
function message(id: string, role: string, second = 0, requestId = "request-1"): Message {
  return { id, role, requestId, text: id, createdAt: at(second), persistedMessageId: id };
}
function interaction(sequence = 1, second = 2, requestId = "request-1", generation = "generation-1") {
  return projectUserInteractionEvent({
    type: "event", name: "user.interaction", requestId, generation,
    interaction: { version: 1, interactionId: requestId + ":interaction:" + sequence,
      requestId, sequence, createdAt: at(second), kind: "message", payload: { text: "Update " + sequence },
      origin: { callId: "root", activationCount: 1, steeringVersion: 0 } },
  })!;
}
function snapshot(status = "completed", generation = "generation-1") {
  return {
    messages: [message("user", "user"), ...(status === "streaming" ? [] : [message("saved", "assistant", 7)])],
    requests: [{ requestId: "request-1", status, lifecycle: { schemaVersion: 1, requestId: "request-1", generation, revision: 1, status } }],
    newerCursor: null,
  };
}

describe("SPARK interaction snapshot reconciliation", () => {
  test.each(["streaming", "completed"])("keeps updates in order across repeated %s refreshes", (status) => {
    const update1 = interaction(1, 2);
    const update2 = interaction(2, 5);
    const response = status === "streaming"
      ? { ...message("assistant-request-1", "assistant", 1), streaming: true, persistedMessageId: undefined }
      : message("saved", "assistant", 7);
    let current = [message("user", "user"), update1, update2, response];
    for (let index = 0; index < 2; index++) current = mergeSparkSnapshotMessages(snapshot(status), current);
    expect(current.map((entry) => entry.id)).toEqual(["user", update1.id, update2.id, response.id]);
  });

  test("keeps an active update before an optimistic user row has a request binding", () => {
    const update = interaction();
    const user = message("user", "user", 0, "");
    const active = { ...snapshot("streaming"), messages: [user] };
    expect(mergeSparkSnapshotMessages(active, [user, update]).map((entry: Message) => entry.id))
      .toEqual(["user", update.id]);
  });

  test("does not retain interactions from replaced generations or outside the resulting history window", () => {
    const old = interaction();
    expect(mergeSparkSnapshotMessages(snapshot("completed", "generation-2"),
      [message("user", "user"), old, message("saved", "assistant")])).not.toContain(old);
    expect(mergeSparkSnapshotMessages({ messages: [], requests: [], newerCursor: null },
      [message("user", "user"), old, message("saved", "assistant")])).toEqual([]);
  });

  test("retains older loaded updates and a targeted window without appending unseen latest rows", () => {
    const update = interaction(1, 2, "old-request");
    const older = [message("old-user", "user", 0, "old-request"), update, message("old-answer", "assistant", 3, "old-request")];
    const current = [...older, message("user", "user"), message("saved", "assistant", 7)];
    expect(mergeSparkSnapshotMessages(snapshot(), current).map((entry: Message) => entry.id))
      .toEqual([...older.map((entry) => entry.id), "user", "saved"]);
    expect(mergeSparkSnapshotMessages(snapshot(), older, true)).toEqual(older);
  });

  test.each(["streaming", "completed"])("normal sync preserves updates and the response binding (%s)", async (status) => {
    const update = interaction();
    const response = status === "streaming"
      ? { ...message("assistant-request-1", "assistant", 1), streaming: true, persistedMessageId: undefined }
      : message("saved", "assistant", 7);
    const state = { messages: [message("user", "user"), update, response], currentSessionId: "spark",
      composerSending: false, activeRequestId: status === "streaming" ? "request-1" : "",
      requestMessages: new Map<string, string>(), requestLifecycles: new Map() };
    const result = { sessionId: "spark", modelProfileId: "model", snapshot: snapshot(status),
      readState: { readGeneration: "history-one", unreadMessageIds: [] } };
    const client = { loadSparkChat: vi.fn(async () => result), listModels: vi.fn(async () => ({ profiles: [{ id: "model" }] })) };
    const conversation = { state, session: { openSession: vi.fn(async () => {}), history: { hasNewer: () => false, refresh() {} } }, render: vi.fn(), update: vi.fn() };
    const sync = createSparkChatSync({ client, getEnvironmentId: () => "dev", conversation,
      onConfiguration: vi.fn(), onReadState: vi.fn(), onSnapshot: vi.fn(), onError: vi.fn(), isAvailable: () => true });
    await sync.refresh({ wait: true });
    await sync.refresh({ wait: true });
    expect(conversation.session.openSession).toHaveBeenCalledTimes(1);
    expect(state.messages.map((entry) => entry.id)).toEqual(["user", update.id, response.id]);
    expect(state.requestMessages.get("request-1")).toBe(response.id);
    expect(state.activeRequestId).toBe(status === "streaming" ? "request-1" : "");
  });

  test("an interaction without an answer never becomes the final-response binding", async () => {
    const update = interaction();
    const state = { messages: [message("user", "user"), update], currentSessionId: "spark", composerSending: false,
      activeRequestId: "", requestMessages: new Map<string, string>(), requestLifecycles: new Map() };
    const result = { sessionId: "spark", modelProfileId: "model", snapshot: { messages: [message("user", "user")], requests: [], newerCursor: null } };
    const conversation = { state, session: { openSession: vi.fn(async () => {}) }, render: vi.fn(), update: vi.fn() };
    const sync = createSparkChatSync({
      client: { loadSparkChat: async () => result, listModels: async () => ({ profiles: [{ id: "model" }] }) },
      getEnvironmentId: () => "dev", conversation, onConfiguration() {}, onReadState() {}, onSnapshot() {}, onError: vi.fn(), isAvailable: () => true,
    });
    await sync.refresh({ wait: true });
    await sync.refresh({ wait: true });
    expect(state.messages).toContain(update);
    expect(state.requestMessages.has("request-1")).toBe(false);
  });
});

describe("approval continuation order with conversational updates", () => {
  const approval = { ...message("approval", "assistant", 3), kind: "tool_approval_request" };
  const answer = message("final", "assistant", 7);

  test("places the grouped final response after an update sent after approval", () => {
    const update1 = interaction(1, 2);
    const update2 = interaction(2, 5);
    const projected = projectApprovalContinuations([message("user", "user"), update1, approval, update2, answer]);
    expect(projected.map((entry) => entry.id)).toEqual(["user", update1.id, update2.id, "final"]);
    expect(projected.at(-1)?.createdAt).toBe(answer.createdAt);
  });

  test("keeps a still-pending approval before an update emitted afterward", () => {
    const update = interaction(1, 5);
    expect(projectApprovalContinuations([approval, update]).map((entry) => entry.id)).toEqual(["approval", update.id]);
  });

  test("keeps exact previous grouping when the request has no interactions", () => {
    const between = message("steer", "user", 5);
    expect(projectApprovalContinuations([approval, between, answer]))
      .toEqual([{ ...answer, createdAt: approval.createdAt }, between]);
  });

  test("other requests' updates cannot move the approval continuation anchor", () => {
    const other = interaction(1, 5, "other-request");
    expect(projectApprovalContinuations([approval, other, answer]))
      .toEqual([{ ...answer, createdAt: approval.createdAt }, other]);
  });
});
