import { vi } from "vitest";
import type { SessionMessage, SessionRecord } from "../../../sessions/types.js";
import { resolveSessionMemoryCheckpointCommit } from "../../../sessions/memory/rules.js";
import { createRequestSessionMemory, type SessionMemoryCompactor } from "../../context/session-memory/index.js";

export const timestamp = "2026-10-02T12:00:00.000Z";

export function initiative(index: number): SessionMessage {
  return { id: `initiative-${index}`, role: "assistant", source: "co_worker", grounding: "conversation",
    content: `Suggestion ${index}`, createdAt: timestamp,
    initiative: { kind: "proactive_proposal_v1", proposalId: `proposal-${index}`, reason: `Private reason ${index}`,
      handoffBrief: `Private handoff ${index}`, sources: [{ kind: "candidate", id: `topic-${index}`, version: "1" }] } };
}

export function ordinaryTurn(index: number): SessionMessage[] {
  return [
    { id: `user-${index}`, role: "user", content: `Question ${index}`, createdAt: timestamp, requestId: `request-${index}` },
    { id: `assistant-${index}`, role: "assistant", content: `Answer ${index}`, createdAt: timestamp, requestId: `request-${index}` },
  ];
}

export function session(messages: SessionMessage[]): SessionRecord {
  return { id: "conversation", title: "Conversation", createdAt: timestamp, updatedAt: timestamp,
    lastAgentMode: "reasoning", messageCount: messages.length, messages };
}

export function memoryFor(record: SessionRecord) {
  const compact = vi.fn<SessionMemoryCompactor["compact"]>(async () => "Summary of settled conversation.");
  const repository = { async compareAndSwapSessionMemoryCheckpoint(_id, command) {
    const result = resolveSessionMemoryCheckpointCommit(record, command);
    if (result.committed) record.sessionMemoryCheckpoint = result.checkpoint;
    return result;
  } } satisfies Parameters<typeof createRequestSessionMemory>[0]["repository"];
  const options = { sessionId: record.id, compactor: { compact }, now: () => new Date(timestamp), repository };
  return { memory: createRequestSessionMemory({ ...options, session: record }), compact, options };
}
