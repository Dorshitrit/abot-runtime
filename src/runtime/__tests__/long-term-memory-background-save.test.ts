import { describe, expect, test, vi } from "vitest";

import { createInMemoryLongTermMemoryRepository } from "../adapters/long-term-memory/in-memory-repository.js";
import { createLongTermMemorySaveQueue } from "../long-term-memory/background-save-queue.js";
import { createLongTermMemoryService } from "../long-term-memory/service.js";

describe("long-term memory background save queue", () => {
  test("runs saves in FIFO order without blocking enqueue", async () => {
    const order: string[] = [];
    const process = vi.fn(async (input) => {
      order.push(input.candidates[0]?.content ?? "missing");
      return result();
    });
    const queue = createLongTermMemorySaveQueue({ process, timeoutMs: 100 });

    queue.enqueue(save("first"));
    queue.enqueue(save("second"));
    expect(order).toEqual([]);

    await queue.drain();
    expect(order).toEqual(["first", "second"]);
  });

  test("advances after a non-cooperative save exceeds its deadline", async () => {
    const completed: string[] = [];
    const process = vi.fn(async (input) => {
      const content = input.candidates[0]?.content;
      if (content === "stalled") {
        return new Promise<ReturnType<typeof result>>(() => undefined);
      }
      completed.push(content ?? "missing");
      return result();
    });
    const queue = createLongTermMemorySaveQueue({ process, timeoutMs: 5 });

    queue.enqueue(save("stalled"));
    queue.enqueue(save("continued"));
    await queue.drain();

    expect(completed).toEqual(["continued"]);
  });

  test("reports enqueue before terminal delivery without projecting background lifecycle", async () => {
    const repository = createInMemoryLongTermMemoryRepository();
    const onEvent = vi.fn();
    const service = createLongTermMemoryService({
      repository,
      embeddings: {
        embed: vi.fn(async ({ texts }) => ({
          modelFingerprint: "background-save-fixture",
          dimensions: 1,
          vectors: texts.map(() => [1]),
        })),
      },
      enabled: true,
      emitClientEvents: true,
      createId: () => "memory-background-save",
    });

    service.scheduleCandidates({
      candidates: [{ content: "Remember the queued save.", tags: ["fixture"] }],
      context: {
        requestId: "request-background-save",
        sessionId: "session-background-save",
        onEvent,
      },
    });

    expect(onEvent).toHaveBeenCalledExactlyOnceWith("memory.save.queued", {
      stage: "long_term_memory",
      proposedCount: 1,
    });
    await vi.waitFor(async () => {
      expect((await repository.read()).learningCandidates).toHaveLength(1);
    });
    expect((await repository.read()).records).toHaveLength(0);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  test("detaches the canonical assessment before delayed background work", async () => {
    const process = vi.fn(async () => result());
    const queue = createLongTermMemorySaveQueue({ process });
    const assessment = { score: 95, reason: "A durable preference.", reinforced: true,
      evidence: { sourceSessionId: "session", sourceRequestId: "request", observedAt: "2026-09-26T10:00:00Z", evidenceDigest: "a".repeat(64) } };
    queue.enqueue({ candidates: [{ content: "Prefers concise answers.", tags: [], assessment }], requestId: "request", sessionId: "session" });
    assessment.score = 100;
    assessment.evidence.sourceRequestId = "replaced";
    await queue.drain();
    expect(process).toHaveBeenCalledWith(expect.objectContaining({ candidates: [expect.objectContaining({
      assessment: expect.objectContaining({ score: 95, evidence: expect.objectContaining({ sourceRequestId: "request" }) }),
    })] }));
  });
});

function save(content: string) {
  return {
    candidates: [{ content, tags: ["fixture"] }],
    requestId: `request-${content}`,
    sessionId: "session-background-save",
  } as const;
}

function result() {
  return {
    available: true,
    proposedCount: 1,
    acceptedCount: 1,
    rejectedCount: 0,
    duplicateCount: 0,
  } as const;
}
