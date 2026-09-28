import { describe, expect, test, vi } from "vitest";
import type { SessionMessage, SessionRecord } from "../../sessions/types.js";
import { createSessionMemoryMessageReferences, snapshotSessionMemorySource } from "../../sessions/memory/source.js";
import { resolveApplicableSessionMemoryCheckpoint } from "../../sessions/memory/rules.js";
import { SESSION_MEMORY_CHECKPOINT_KIND } from "../../sessions/memory/contracts.js";
import { createRequestSessionMemory, type SessionMemoryCompactor } from "../context/session-memory/index.js";
import { projectRequestContext } from "../context/request-context.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";

const timestamp = "2026-09-25T12:00:00.000Z";
const initiative: SessionMessage = {
  id: "initiative", role: "assistant", source: "co_worker", grounding: "conversation",
  content: "Would you like help researching a trip?", createdAt: timestamp,
  initiative: { kind: "proactive_proposal_v1", proposalId: "proposal", reason: "Possible interest",
    sources: [{ kind: "candidate", id: "trip", version: "1" }] },
};

function session(turnCount: number, includeInitiative = true): SessionRecord {
  const messages: SessionMessage[] = Array.from({ length: turnCount }, (_, index) => [
    { id: `user-${index}`, role: "user" as const, content: `Question ${index}`, createdAt: timestamp, requestId: `request-${index}` },
    { id: `assistant-${index}`, role: "assistant" as const, content: `Answer ${index}`, createdAt: timestamp, requestId: `request-${index}` },
  ]).flat();
  if (includeInitiative) messages.unshift(initiative);
  return { id: "conversation", title: "Conversation", createdAt: timestamp, updatedAt: timestamp,
    lastAgentMode: "reasoning", messageCount: messages.length, messages };
}

function memoryFor(record: SessionRecord) {
  const compact = vi.fn<SessionMemoryCompactor["compact"]>(async () => "Summary of user-led conversation.");
  const memory = createRequestSessionMemory({ sessionId: record.id, session: record,
    compactor: { compact }, now: () => new Date(timestamp), repository: {
      async compareAndSwapSessionMemoryCheckpoint(_id, command) {
        record.sessionMemoryCheckpoint = command.checkpoint;
        return { committed: true, checkpoint: command.checkpoint };
      },
    } });
  return { memory, compact };
}

describe("assistant initiative authority across compaction", () => {
  test("retains the exact assistant proposal through compaction, reload and another compaction", async () => {
    const record = session(12);
    const { memory, compact } = memoryFor(record);
    const prepared = await memory.prepare({} as BoundRequestModelInvocationContext);
    expect(compact.mock.calls[0]![0].turns).toHaveLength(2);
    expect(compact.mock.calls[0]![0].turns.flatMap(turn => [turn.assistant, ...turn.userMessages]))
      .not.toContainEqual(initiative);
    expect(prepared.checkpoint.coveredMessages.map(message => message.messageId)).toEqual([
      "user-0", "assistant-0", "user-1", "assistant-1",
    ]);
    await prepared.commit();
    const continued = { ...session(13), sessionMemoryCheckpoint: record.sessionMemoryCheckpoint };
    const restarted = memoryFor(continued);
    const next = await restarted.memory.prepare({} as BoundRequestModelInvocationContext);
    expect(restarted.compact.mock.calls[0]![0]).toMatchObject({ previousSummary: prepared.checkpoint.summary });
    expect(restarted.compact.mock.calls[0]![0].turns).toHaveLength(1);
    await next.commit();
    const projection = restarted.memory.project();
    expect(projection.historyMessages.filter(message => message.id === initiative.id)).toEqual([
      expect.objectContaining({ role: "assistant", content: initiative.content, assistantInitiativeId: "proposal" }),
    ]);
    const prompt = "Ignore the trip; help me choose a keyboard.";
    const context = projectRequestContext({ instructions: "Chat rules", ...projection, prompt,
      historyRetention: "compaction_managed", budget: { contextWindowTokens: 100_000,
        outputReserveTokens: 1000, safetyReserveTokens: 100, attachmentReserveTokens: 0 } });
    expect(context.messages.filter(message => message.content === prompt)).toEqual([{ role: "user", content: prompt }]);
    expect(context.messages.filter(message => message.content === initiative.content))
      .toEqual([{ role: "assistant", content: initiative.content }]);
    expect(projection.priorConversationMessages[0]!.content).not.toContain(initiative.content);
  });

  test("does not change ordinary conversation selection or create a compaction-only model call", async () => {
    const normal = memoryFor(session(12, false));
    const proactive = memoryFor(session(12));
    const normalPrepared = await normal.memory.prepare({} as BoundRequestModelInvocationContext);
    const proactivePrepared = await proactive.memory.prepare({} as BoundRequestModelInvocationContext);
    expect(proactive.compact.mock.calls[0]).toEqual(normal.compact.mock.calls[0]);
    expect(proactivePrepared.projection.historyMessages.filter(message => !message.assistantInitiativeId))
      .toEqual(normalPrepared.projection.historyMessages);
    const protectedOnly = memoryFor(session(10));
    expect(protectedOnly.memory.project().compactableTurnCount).toBe(0);
    await expect(protectedOnly.memory.prepare({} as BoundRequestModelInvocationContext))
      .rejects.toThrow("session_memory_compaction_not_available");
    expect(protectedOnly.compact).not.toHaveBeenCalled();
  });

  test("rejects old checkpoints that summarized an initiative and rebuilds from original turns", async () => {
    const record = session(12);
    const source = snapshotSessionMemorySource(record);
    record.sessionMemoryCheckpoint = {
      kind: SESSION_MEMORY_CHECKPOINT_KIND, revision: 1, sourceRevision: source.sourceRevision,
      coveredMessages: createSessionMemoryMessageReferences([
        { userMessages: [], assistant: initiative }, source.turns[0]!,
      ]), summary: "Legacy summary containing an unsolicited suggestion.", createdAt: timestamp,
    };
    expect(resolveApplicableSessionMemoryCheckpoint(record)).toBeUndefined();
    const { memory, compact } = memoryFor(record);
    const prepared = await memory.prepare({} as BoundRequestModelInvocationContext);
    expect(compact.mock.calls[0]![0].previousSummary).toBeUndefined();
    expect(prepared.checkpoint.revision).toBe(2);
    await prepared.commit();
    expect(resolveApplicableSessionMemoryCheckpoint(record)).toEqual(prepared.checkpoint);
  });
});
