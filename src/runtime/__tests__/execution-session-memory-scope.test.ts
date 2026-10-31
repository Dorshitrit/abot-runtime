import { describe, expect, it, vi } from "vitest";
import type { SessionMessage, SessionRecord } from "../../sessions/types.js";
import { EXECUTION_TOOL_OBSERVATION_KIND } from "../../sessions/memory/execution-observation.js";
import type { SessionMemoryRepository } from "../../sessions/memory/contracts.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createRequestSessionMemory } from "../context/session-memory/controller.js";
import type { SessionMemoryCompactor } from "../context/session-memory/contracts.js";
import { captureRequestSessionMemory, restoreRequestSessionMemory } from "../context/session-memory/snapshot.js";
import { replaceSessionMemoryProjection } from "../context/session-memory/message-replacement.js";
import { projectRequestContext } from "../context/request-context.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";

const request = {} as BoundRequestModelInvocationContext;

function fixture() {
  const messages: SessionMessage[] = [
    { id: "user-1", role: "user", content: "Collect facts", requestId: "request-1", createdAt: "2026-10-27T00:00:00.000Z" },
    { id: "assistant-1", role: "assistant", content: "I found the facts.", requestId: "request-1", createdAt: "2026-10-27T00:00:01.000Z",
      observationContent: JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND, requestId: "request-1",
        results: [{ executionId: "execution-1", outcome: "completed", content: "EXACT_TOOL_VALUE" }] }) },
  ];
  const session: SessionRecord = { id: "history", title: "history", createdAt: messages[0]!.createdAt,
    updatedAt: messages[1]!.createdAt, lastAgentMode: "reasoning", messageCount: messages.length, messages };
  const repository = createInMemorySessionStore({ initialSessions: [session] });
  const compact = vi.fn<SessionMemoryCompactor["compact"]>(async () => "Collected fact: EXACT_TOOL_VALUE. The user asked to collect facts.");
  const options = { sessionId: session.id, session, repository, compactor: { compact } };
  return { session, repository, compact, options };
}

describe("EA session history scope", () => {
  it("includes collected data once without altering SUPER history or raw stored messages", () => {
    const { session, options } = fixture();
    const original = structuredClone(session);
    const execution = createRequestSessionMemory({ ...options, scope: "execution_agent" }).project();
    const ordinary = createRequestSessionMemory(options).project();
    expect(execution.historyMessages.map(({ role }) => role)).toEqual(["user", "assistant"]);
    const assistant = JSON.parse(execution.historyMessages[1]!.content);
    expect(assistant).toMatchObject({ authority: "prior_conversation", assistantResponse: session.messages[1]!.content,
      toolObservation: { requestId: "request-1", results: [{ content: "EXACT_TOOL_VALUE" }] } });
    expect(JSON.stringify(execution.historyMessages).match(/EXACT_TOOL_VALUE/gu)).toHaveLength(1);
    expect(ordinary.historyMessages.map(({ content }) => content)).toEqual(session.messages.map(({ content }) => content));
    expect(ordinary.compactableTurnCount).toBe(0);
    expect(execution.compactableTurnCount).toBe(1);
    expect(session).toEqual(original);
  });

  it("compacts even a recent EA turn, replaces its raw data, and reloads the scoped summary", async () => {
    const { options, compact, repository, session } = fixture();
    const memory = createRequestSessionMemory({ ...options, scope: "execution_agent" });
    const before = memory.project();
    const currentPrompt = "Save the collected facts";
    const input = projectRequestContext({ instructions: "Runtime instructions", ...before, prompt: currentPrompt,
      historyRetention: "compaction_managed", budget: { contextWindowTokens: 100_000, outputReserveTokens: 1000,
        safetyReserveTokens: 100, attachmentReserveTokens: 0 } });
    const prepared = await memory.prepare(request);
    expect(compact.mock.calls[0]?.[0]).toMatchObject({ scope: "execution_agent", turns: [{ assistant: session.messages[1] }] });
    const projected = replaceSessionMemoryProjection({ messages: input.messages, current: before, next: prepared.projection });
    expect(projected.filter(({ role }) => role === "user")).toEqual([{ role: "user", content: currentPrompt }]);
    expect(JSON.stringify(projected)).toContain("EXACT_TOOL_VALUE");
    expect(JSON.stringify(projected)).not.toContain(EXECUTION_TOOL_OBSERVATION_KIND);
    await prepared.commit();
    const loaded = (await repository.getSessionById(session.id))!;
    expect(loaded.executionSessionMemoryCheckpoint).toEqual(prepared.checkpoint);
    expect(loaded.sessionMemoryCheckpoint).toBeUndefined();
    const continued = createRequestSessionMemory({ ...options, session: loaded, scope: "execution_agent" });
    expect(continued.project()).toEqual(memory.project());
    expect(continued.project().historyMessages).toEqual([]);
    const superMemory = createRequestSessionMemory({ ...options, session: loaded });
    expect(superMemory.project().priorConversationMessages).toEqual([]);
    expect(superMemory.project().historyMessages.map(({ content }) => content)).toEqual(session.messages.map(({ content }) => content));
  });

  it("freezes an EA snapshot scope across restore and rejects inconsistent or tampered source", () => {
    const { options } = fixture();
    const memory = createRequestSessionMemory({ ...options, scope: "execution_agent" });
    const snapshot = JSON.parse(JSON.stringify(captureRequestSessionMemory(memory)));
    expect(snapshot.scope).toBe("execution_agent");
    expect(snapshot.source.scope).toBe("execution_agent");
    const restored = restoreRequestSessionMemory(snapshot, options);
    expect(restored.project()).toEqual(memory.project());
    expect(captureRequestSessionMemory(restored)).toEqual(snapshot);
    expect(() => restoreRequestSessionMemory({ ...snapshot, scope: undefined }, options))
      .toThrow("session_memory_snapshot_scope_invalid");
    snapshot.source.historyMessages[1].observationContent = JSON.stringify({ kind: EXECUTION_TOOL_OBSERVATION_KIND,
      requestId: "request-1", results: [{ content: "REPLACED_TOOL_VALUE" }] });
    expect(() => restoreRequestSessionMemory(snapshot, options)).toThrow("session_memory_snapshot_source_invalid");
  });

  it("keeps old snapshots conversation-only even when new restore options request EA scope", () => {
    const { options } = fixture();
    const legacy = createRequestSessionMemory(options);
    const snapshot = captureRequestSessionMemory(legacy);
    expect(snapshot).not.toHaveProperty("scope");
    const restored = restoreRequestSessionMemory(snapshot, { ...options, scope: "execution_agent" });
    expect(restored.project()).toEqual(legacy.project());
    expect(captureRequestSessionMemory(restored)).toEqual(snapshot);
  });

  it("does not advance the context after a rejected scoped checkpoint commit", async () => {
    const { options } = fixture();
    const compareAndSwapSessionMemoryCheckpoint = vi.fn<SessionMemoryRepository["compareAndSwapSessionMemoryCheckpoint"]>(async () => ({ committed: false as const, reason: "source_revision_mismatch" as const }));
    const memory = createRequestSessionMemory({ ...options, scope: "execution_agent", repository: { compareAndSwapSessionMemoryCheckpoint } });
    const before = memory.project();
    const prepared = await memory.prepare(request);
    await expect(prepared.commit()).rejects.toThrow("session_memory_source_revision_mismatch");
    expect(memory.project()).toEqual(before);
    expect(compareAndSwapSessionMemoryCheckpoint.mock.calls[0]?.[1]).toMatchObject({ scope: "execution_agent" });
  });
});
