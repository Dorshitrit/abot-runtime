import { describe, expect, test } from "vitest";
import { projectSessionSnapshot } from "./snapshot.js";
import type { SessionRecord, SessionRequestRecord } from "./types.js";

const iso = (value: number) => new Date(value).toISOString();
function conversation(count = 45): SessionRecord {
  return {
    id: "conversation", title: "History", createdAt: iso(0), updatedAt: iso(count), lastAgentMode: "reasoning", messageCount: count,
    messages: Array.from({ length: count }, (_, i) => ({ id: `msg-${i + 1}`, role: "assistant", content: `answer ${i + 1}`, createdAt: iso(i + 1), requestId: `request-${i + 1}` })),
    requests: Array.from({ length: count }, (_, i): SessionRequestRecord => ({
      requestId: `request-${i + 1}`, sessionId: "conversation", status: "completed", createdAt: iso(i + 1), updatedAt: iso(i + 1), lastSeqNo: 1,
      events: [{ type: "completed", requestId: `request-${i + 1}`, seqNo: 1, timestamp: iso(i + 1), payload: { output: `answer ${i + 1}` } }],
    })),
  };
}
describe("session history pages", () => {
  test("bounds message and event projection without changing canonical or legacy history", () => {
    const session = conversation();
    const before = structuredClone(session);
    const latest = projectSessionSnapshot(session, { page: { limit: 20 } });
    expect(latest.messages.map((message) => message.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 26));
    expect(latest.requests.map((request) => request.requestId)).toEqual(latest.messages.map((message) => message.requestId));
    expect(latest.requests.every((request) => request.events.length === 1)).toBe(true);
    expect(latest.messageIndex).toHaveLength(45);
    expect(latest.messageIndex?.[0]).not.toHaveProperty("text");
    expect(latest.newerCursor).toBeNull();
    const older = projectSessionSnapshot(session, { page: { limit: 20, cursor: latest.nextCursor } });
    const oldest = projectSessionSnapshot(session, { page: { limit: 20, cursor: older.nextCursor } });
    expect([...oldest.messages, ...older.messages, ...latest.messages].map((message) => message.id)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
    expect(oldest.nextCursor).toBeNull();
    expect(projectSessionSnapshot(session).messages).toHaveLength(45);
    expect(projectSessionSnapshot(session)).not.toHaveProperty("messageIndex");
    expect(session).toEqual(before);
  });
  test("cursor stays anchored when messages arrive, and rejects cleared or foreign history", () => {
    const session = conversation();
    const cursor = projectSessionSnapshot(session, { page: { limit: 20 } }).nextCursor;
    session.messages.push({ id: "msg-46", role: "user", content: "new", createdAt: iso(46) });
    expect(projectSessionSnapshot(session, { page: { limit: 20, cursor } }).messages.at(-1)?.id).toBe(25);
    expect(() => projectSessionSnapshot({ ...session, id: "other" }, { page: { limit: 20, cursor } })).toThrow("history_cursor_stale");
    session.messages = session.messages.map((message) => ({ ...message, createdAt: iso(999) }));
    expect(() => projectSessionSnapshot(session, { page: { limit: 20, cursor } })).toThrow("history_cursor_stale");
  });
  test("old SPARK targets get a bounded window and forward continuation", () => {
    const session = conversation();
    const targeted = projectSessionSnapshot(session, { page: { limit: 20, targetMessageId: "3", targetCreatedAt: 3, targetRequestId: "request-3" } });
    expect(targeted.messages[0]?.id).toBe(3);
    expect(targeted.messages).toHaveLength(20);
    const following = projectSessionSnapshot(session, { page: { limit: 20, cursor: targeted.newerCursor } });
    expect(following.messages[0]?.id).toBe(23);
    const stale = projectSessionSnapshot(session, { page: { limit: 20, targetMessageId: "3", targetCreatedAt: 99 } });
    expect(stale.messages[0]?.id).toBe(26);
  });
  test("restores active requests and queue dependencies without all settled request events", () => {
    const session = conversation();
    session.requests![0]!.status = "streaming";
    session.requests![1]!.status = "awaiting_approval";
    const page = projectSessionSnapshot(session, { page: { limit: 2, waitingRequestId: "request-3" } });
    expect(page.requests.map((request) => request.requestId)).toEqual(["request-1", "request-2", "request-3", "request-44", "request-45"]);
    const older = projectSessionSnapshot(session, { page: { limit: 2, cursor: page.nextCursor } });
    expect(older.requests.map((request) => request.requestId)).toEqual(["request-42", "request-43"]);
  });
  test("read identities preserve legacy inferred request IDs without bodies or events", () => {
    const session = conversation(3);
    for (const message of session.messages) delete message.requestId;
    const identities = projectSessionSnapshot(session, { identitiesOnly: true });
    expect(identities.messageIndex?.map((message) => message.requestId)).toEqual(["request-1", "request-2", "request-3"]);
    expect(identities.messages).toEqual([]);
    expect(identities.requests).toEqual([]);
    expect(projectSessionSnapshot(session, { afterMessageId: 1 }).messages.map((message) => message.id)).toEqual([2, 3]);
  });
});


test("compact read identities preserve presentation kind without changing public history", () => {
  const session = conversation(3);
  session.messages[0]!.kind = "tool_approval_request";
  session.messages[1]!.kind = "terminal";
  const original = structuredClone(session);
  for (const options of [{ identitiesOnly: true }, { page: { limit: 1 } }]) {
    const snapshot = projectSessionSnapshot(session, options);
    expect(snapshot.messageIndex?.map((message) => message.kind)).toEqual(["tool_approval_request", "terminal", undefined]);
    expect(snapshot.messageIndex?.every((message) => !("text" in message))).toBe(true);
  }
  expect(projectSessionSnapshot(session).messages.map((message) => message.kind))
    .toEqual(["tool_approval_request", "terminal", undefined]);
  expect(session).toEqual(original);
});
