import { describe, expect, it, vi } from "vitest";
import type { SessionMemoryRepository, SessionMemoryScope } from "../../sessions/memory/contracts.js";
import type { SessionMessage, SessionRecord } from "../../sessions/types.js";
import { createInMemorySessionStore } from "../adapters/in-memory-session-store.js";
import { createRequestSessionMemory } from "../context/session-memory/controller.js";
import type { SessionMemoryCompactor } from "../context/session-memory/contracts.js";
import { createSessionMemoryAwareCompactionController } from "../context/session-memory/model-step-controller.js";
import { projectSessionMemoryMessages } from "../context/session-memory/projection.js";
import type { BoundRequestModelInvocationContext } from "../request/contracts.js";

const request = {} as BoundRequestModelInvocationContext;

function fixture(scope: SessionMemoryScope | null = "execution_agent", turns = 1) {
  const messages: SessionMessage[] = Array.from({ length: turns }, (_, index) => [
    { id: `u-${index}`, role: "user" as const, content: `Collect ${index}`, requestId: `r-${index}`, createdAt: "2026-10-27T00:00:00.000Z" },
    { id: `a-${index}`, role: "assistant" as const, content: `Collected ${index}`, requestId: `r-${index}`, createdAt: "2026-10-27T00:00:01.000Z" },
  ]).flat();
  const session: SessionRecord = { id: "parallel-history", title: "history", createdAt: messages[0]!.createdAt,
    updatedAt: messages.at(-1)!.createdAt, lastAgentMode: "reasoning", messageCount: messages.length, messages };
  const store = createInMemorySessionStore({ initialSessions: [session] });
  const compareAndSwapSessionMemoryCheckpoint = vi.fn<SessionMemoryRepository["compareAndSwapSessionMemoryCheckpoint"]>(
    (...args) => store.compareAndSwapSessionMemoryCheckpoint(...args),
  );
  const compact = vi.fn<SessionMemoryCompactor["compact"]>(async () => "The previously collected fact.");
  const memory = createRequestSessionMemory({ ...(scope ? { scope } : {}), sessionId: session.id, session,
    repository: { compareAndSwapSessionMemoryCheckpoint }, compactor: { compact } });
  const controller = createSessionMemoryAwareCompactionController({ ...request, sessionId: session.id, sessionMemory: memory }, {
    project: (input) => [...input], getStages: () => [], hasExhaustedVerifiedCompactionSources: () => true,
  });
  const messagesForInvocation = () => controller.project([...projectSessionMemoryMessages(memory.project()), { role: "user", content: "Use the facts" }]);
  return { memory, controller, store, compact, compareAndSwapSessionMemoryCheckpoint, messagesForInvocation };
}

describe("EA history coordination between parallel payload authors", () => {
  it("shares generation and the successful CAS, including repeated commit calls", async () => {
    const { memory, compact, compareAndSwapSessionMemoryCheckpoint, store } = fixture();
    const before = memory.project();
    const [left, right] = await Promise.all([memory.prepare(request), memory.prepare(request)]);
    expect(left).toBe(right);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(memory.project()).toEqual(before);
    expect(memory.snapshot!().checkpoint).toBeUndefined();
    await Promise.all([left.commit(), right.commit()]);
    await left.commit();
    expect(compareAndSwapSessionMemoryCheckpoint).toHaveBeenCalledTimes(1);
    expect(memory.project()).toEqual(left.projection);
    expect((await store.getSessionById("parallel-history"))!.executionSessionMemoryCheckpoint).toEqual(left.checkpoint);
  });

  it("releases failed generation without retaining a failed candidate", async () => {
    const { memory, compact } = fixture();
    compact.mockRejectedValueOnce(new Error("summary_failed"));
    const outcomes = await Promise.allSettled([memory.prepare(request), memory.prepare(request)]);
    expect(outcomes.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    expect(compact).toHaveBeenCalledTimes(1);
    await (await memory.prepare(request)).commit();
    expect(compact).toHaveBeenCalledTimes(2);
    expect(memory.project().checkpointRevision).toBe(1);
  });

  it("shares a rejected CAS without changing context and permits a new preparation", async () => {
    const { memory, compact, compareAndSwapSessionMemoryCheckpoint } = fixture();
    compareAndSwapSessionMemoryCheckpoint.mockResolvedValueOnce({ committed: false, reason: "source_revision_mismatch" });
    const before = memory.project();
    const [left, right] = await Promise.all([memory.prepare(request), memory.prepare(request)]);
    const commits = await Promise.allSettled([left.commit(), right.commit()]);
    expect(commits.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    await expect(left.commit()).rejects.toThrow("session_memory_source_revision_mismatch");
    expect(compareAndSwapSessionMemoryCheckpoint).toHaveBeenCalledTimes(1);
    expect(memory.project()).toEqual(before);
    await (await memory.prepare(request)).commit();
    expect(compact).toHaveBeenCalledTimes(2);
    expect(compareAndSwapSessionMemoryCheckpoint).toHaveBeenCalledTimes(2);
    expect(memory.project().checkpointRevision).toBe(1);
  });

  it.each(["before_stage_capture", "after_stage_capture", "after_refresh"] as const)(
    "uses a peer checkpoint committed %s without regenerating or mismatching history", async (timing) => {
      const { memory, controller, compact, compareAndSwapSessionMemoryCheckpoint, messagesForInvocation } = fixture();
      const original = messagesForInvocation();
      expect(controller.projectForCompaction!(original)).toBe(original);
      const peer = await memory.prepare(request);
      if (timing === "before_stage_capture") await peer.commit();
      const stages = controller.getStages();
      if (timing === "after_stage_capture") await peer.commit();
      let projected = controller.projectForCompaction!(original);
      if (timing === "after_refresh") await peer.commit();
      if (stages.length > 0) {
        const outcome = await stages[0]!.prepare(projected);
        expect(outcome.kind).toBe("prepared");
        if (outcome.kind !== "prepared") throw new Error("expected_prepared_history");
        projected = outcome.preparation.messages;
        expect(outcome.preparation.hasExhaustedCompactionSources).toBe(true);
        await outcome.preparation.commit();
      }
      expect(projected).toEqual([...projectSessionMemoryMessages(memory.project()), { role: "user", content: "Use the facts" }]);
      expect(compact).toHaveBeenCalledTimes(1);
      expect(compareAndSwapSessionMemoryCheckpoint).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves default parallel preparation, strict commits and admission projection", async () => {
    const { memory, controller, compact, compareAndSwapSessionMemoryCheckpoint } = fixture(null, 11);
    const [left, right] = await Promise.all([memory.prepare(request), memory.prepare(request)]);
    expect(left).not.toBe(right);
    expect(compact).toHaveBeenCalledTimes(2);
    await left.commit();
    await expect(left.commit()).rejects.toThrow("session_memory_checkpoint_already_committed");
    await expect(right.commit()).rejects.toThrow("session_memory_checkpoint_revision_mismatch");
    expect(compareAndSwapSessionMemoryCheckpoint).toHaveBeenCalledTimes(2);
    expect(controller.projectForCompaction).toBeUndefined();
  });
});

it("shared history replays and fans out observations without duplicating generation or CAS", async () => {
  const { memory, compact, compareAndSwapSessionMemoryCheckpoint } = fixture();
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  compact.mockImplementation(async ({ onProgress }) => {
    onProgress?.({ step: "processing", unit: "turns", completedUnits: 0, totalUnits: 1 });
    await ready;
    onProgress?.({ step: "processing", unit: "turns", completedUnits: 1, totalUnits: 1 });
    return "Shared summary";
  });
  const first = vi.fn(); const second = vi.fn();
  const left = memory.prepare(request, first);
  const right = memory.prepare(request, second);
  expect(left).toBe(right);
  expect(second).toHaveBeenCalledWith({ step: "processing", unit: "turns", completedUnits: 0, totalUnits: 1 });
  finish();
  await (await left).commit();
  expect(first.mock.calls).toEqual(second.mock.calls);
  expect(compact).toHaveBeenCalledOnce();
  expect(compareAndSwapSessionMemoryCheckpoint).toHaveBeenCalledOnce();
});
