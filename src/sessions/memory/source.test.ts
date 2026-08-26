import { describe, expect, it } from "vitest";

import type { SessionMessage, SessionRecord } from "../types.js";
import { snapshotSessionMemorySource } from "./source.js";

describe("session memory source", () => {
  it("selects only complete visible user-to-assistant turns", () => {
    const session = createSession([
      message("user-1", "user", "first", "request-1"),
      message("tool-1", "assistant", "tool", "request-1", "tool_observation"),
      message("assistant-1", "assistant", "answer", "request-1"),
      message("user-2", "user", "still pending", "request-2"),
    ]);

    const source = snapshotSessionMemorySource(session);

    expect(source.turns).toHaveLength(1);
    expect(source.turns[0]?.userMessages.map(({ id }) => id)).toEqual([
      "user-1",
    ]);
    expect(source.turns[0]?.assistant.id).toBe("assistant-1");
    expect(source.messageReferences.map(({ messageId }) => messageId)).toEqual([
      "user-1",
      "assistant-1",
    ]);
    expect(source.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("keeps the initial request and later steering in one settled turn", () => {
    const session = createSession([
      message("user-1", "user", "initial request", "request-1"),
      message("steer-1", "user", "additional constraint", "request-1"),
      message("assistant-1", "assistant", "final answer", "request-1"),
    ]);

    const source = snapshotSessionMemorySource(session);

    expect(source.turns).toHaveLength(1);
    expect(source.turns[0]?.userMessages.map(({ id }) => id)).toEqual([
      "user-1",
      "steer-1",
    ]);
    expect(source.messageReferences.map(({ messageId }) => messageId)).toEqual([
      "user-1",
      "steer-1",
      "assistant-1",
    ]);
  });

  it("changes revision when settled conversation content changes", () => {
    const original = createSession([
      message("user-1", "user", "first", "request-1"),
      message("assistant-1", "assistant", "answer", "request-1"),
    ]);
    const changed = createSession([
      message("user-1", "user", "first", "request-1"),
      message("assistant-1", "assistant", "different", "request-1"),
    ]);

    expect(snapshotSessionMemorySource(original).sourceRevision).not.toBe(
      snapshotSessionMemorySource(changed).sourceRevision,
    );
  });
});

function createSession(messages: SessionMessage[]): SessionRecord {
  return {
    id: "session-1",
    title: "session-1",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    lastAgentMode: "reasoning",
    messageCount: messages.length,
    messages,
  };
}

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  requestId: string,
  grounding: SessionMessage["grounding"] = "conversation",
): SessionMessage {
  return {
    id,
    role,
    content,
    requestId,
    grounding,
    createdAt: "2026-08-25T00:00:00.000Z",
  };
}
