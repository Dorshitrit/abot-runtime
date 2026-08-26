import { describe, expect, it, vi } from "vitest";

import type { SessionMemoryCheckpointCommit } from "../../sessions/memory/contracts.js";
import type { SessionRecord } from "../../sessions/types.js";
import {
  createRequestSessionMemory,
  type SessionMemoryCompactor,
} from "../context/session-memory/index.js";
import { projectRootSessionMemory } from "../context/session-memory/root-projection.js";
import { projectRequestContext } from "../context/request-context.js";
import type { RequestHistoryMessage } from "../context/request-context-contracts.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";

describe("request session memory", () => {
  it("keeps ten complete turns raw and prepares only the older prefix", async () => {
    const session = createSession(12);
    const compact = vi.fn<SessionMemoryCompactor["compact"]>(
      async () => "The first two turns are preserved semantically.",
    );
    const commits: SessionMemoryCheckpointCommit[] = [];
    const memory = createRequestSessionMemory({
      sessionId: session.id,
      session,
      compactor: { compact },
      repository: {
        async compareAndSwapSessionMemoryCheckpoint(_sessionId, command) {
          commits.push(command);
          return { committed: true, checkpoint: command.checkpoint };
        },
      },
      now: () => new Date("2026-08-25T01:00:00.000Z"),
    });

    const before = memory.project();
    expect(before.historyMessages).toHaveLength(24);
    expect(before.compactableTurnCount).toBe(2);
    expect(before.priorConversationMessages).toHaveLength(0);

    const prepared = await memory.prepare(
      {} as BoundRequestModelInvocationContext,
    );

    expect(compact).toHaveBeenCalledOnce();
    expect(compact.mock.calls[0]?.[0].turns).toHaveLength(2);
    expect(prepared.checkpoint.coveredMessages).toHaveLength(4);
    expect(prepared.projection.historyMessages).toHaveLength(20);
    expect(prepared.projection.priorConversationMessages[0]?.role).toBe(
      "system",
    );
    expect(commits).toHaveLength(0);

    await prepared.commit();

    expect(commits).toHaveLength(1);
    expect(memory.project()).toEqual(prepared.projection);
    await expect(prepared.commit()).rejects.toThrow(
      "session_memory_checkpoint_already_committed",
    );
  });

  it("extends an applicable checkpoint instead of stacking summaries", async () => {
    const initialSession = createSession(12);
    const initialMemory = createRequestSessionMemory({
      sessionId: initialSession.id,
      session: initialSession,
      compactor: { compact: async () => "Initial summary" },
      repository: {
        async compareAndSwapSessionMemoryCheckpoint(_sessionId, command) {
          return { committed: true, checkpoint: command.checkpoint };
        },
      },
    });
    const initial = await initialMemory.prepare(
      {} as BoundRequestModelInvocationContext,
    );
    await initial.commit();
    const continuedSession = createSession(13);
    continuedSession.sessionMemoryCheckpoint = initial.checkpoint;
    const compact = vi.fn<SessionMemoryCompactor["compact"]>(
      async () => "Replacement summary",
    );
    const memory = createRequestSessionMemory({
      sessionId: continuedSession.id,
      session: continuedSession,
      compactor: { compact },
      repository: {
        async compareAndSwapSessionMemoryCheckpoint(_sessionId, command) {
          return { committed: true, checkpoint: command.checkpoint };
        },
      },
    });

    const prepared = await memory.prepare(
      {} as BoundRequestModelInvocationContext,
    );

    expect(compact.mock.calls[0]?.[0]).toMatchObject({
      previousSummary: "Initial summary",
    });
    expect(compact.mock.calls[0]?.[0].turns).toHaveLength(1);
    expect(prepared.checkpoint.revision).toBe(2);
    expect(prepared.checkpoint.coveredMessages).toHaveLength(6);
  });

  it("projects one passive checkpoint, uncovered complete turns, and one current request", async () => {
    const session = createSession(12);
    const memory = createRequestSessionMemory({
      sessionId: session.id,
      session,
      compactor: { compact: async () => "The first two turns are settled." },
      repository: {
        async compareAndSwapSessionMemoryCheckpoint(_sessionId, command) {
          return { committed: true, checkpoint: command.checkpoint };
        },
      },
    });
    const prepared = await memory.prepare(
      {} as BoundRequestModelInvocationContext,
    );
    await prepared.commit();
    const historyMessages = session.messages.map(toHistoryMessage);
    const rootMemory = projectRootSessionMemory({
      historyMessages,
      sessionMemory: memory,
    });

    const context = projectRequestContext({
      instructions: "Root instructions",
      historyMessages: rootMemory.historyMessages,
      priorConversationMessages: rootMemory.priorConversationMessages,
      historyRetention: rootMemory.historyRetention,
      prompt: "Current request",
      budget: {
        contextWindowTokens: 100_000,
        outputReserveTokens: 1_000,
        safetyReserveTokens: 1_000,
        attachmentReserveTokens: 0,
      },
    });

    expect(context.messages[0]).toEqual({
      role: "system",
      content: "Root instructions",
    });
    expect(context.messages[1]?.role).toBe("system");
    expect(context.messages[1]?.content).toContain(
      "runtime_session_memory_checkpoint_v1",
    );
    expect(
      context.messages.filter(({ content }) =>
        content.includes("The first two turns are settled."),
      ),
    ).toHaveLength(1);
    expect(
      context.messages.some(({ content }) => content === "user message 1"),
    ).toBe(false);
    expect(
      context.messages.some(({ content }) => content === "user message 3"),
    ).toBe(true);
    expect(
      context.messages.filter(({ content }) => content === "Current request"),
    ).toHaveLength(1);
    expect(context.omittedHistoryMessageIds).toEqual([]);
  });

  it("does not mutate persisted session memory when summary generation fails", async () => {
    const session = createSession(11);
    const compareAndSwapSessionMemoryCheckpoint = vi.fn();
    const memory = createRequestSessionMemory({
      sessionId: session.id,
      session,
      compactor: {
        async compact() {
          throw new Error("session_memory_generation_failed");
        },
      },
      repository: { compareAndSwapSessionMemoryCheckpoint },
    });

    await expect(
      memory.prepare({} as BoundRequestModelInvocationContext),
    ).rejects.toThrow("session_memory_generation_failed");

    expect(compareAndSwapSessionMemoryCheckpoint).not.toHaveBeenCalled();
    expect(memory.project().checkpointRevision).toBe(0);
    expect(memory.project().historyMessages).toHaveLength(22);
  });
});

function createSession(turnCount: number): SessionRecord {
  const messages = Array.from({ length: turnCount }, (_, index) => {
    const requestId = `request-${index + 1}`;
    const createdAt = new Date(index * 2_000).toISOString();
    const answeredAt = new Date(index * 2_000 + 1_000).toISOString();
    return [
      {
        id: `user-${index + 1}`,
        role: "user" as const,
        content: `user message ${index + 1}`,
        createdAt,
        requestId,
      },
      {
        id: `assistant-${index + 1}`,
        role: "assistant" as const,
        content: `assistant message ${index + 1}`,
        createdAt: answeredAt,
        requestId,
      },
    ];
  }).flat();
  return {
    id: "session-memory-test",
    title: "session-memory-test",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    lastAgentMode: "reasoning",
    messageCount: messages.length,
    messages,
  };
}

function toHistoryMessage(
  message: SessionRecord["messages"][number],
): RequestHistoryMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    ...(message.requestId ? { requestId: message.requestId } : {}),
  };
}
