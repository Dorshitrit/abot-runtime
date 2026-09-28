import { expect, test, vi } from "vitest";
import { recentLearningMemories } from "../passive-learning/status-projection.js";
import type { LearningBatch } from "../passive-learning/contracts.js";
import type { LongTermMemoryService } from "../long-term-memory/contracts.js";

test("recent previews follow newest batch and record order, skipping deleted records", async () => {
  const history: LearningBatch[] = [
    { status: "saved", recordIds: ["old-1", "old-2"] },
    { status: "saved", recordIds: ["middle"] },
    { status: "saved", recordIds: ["new-1", "new-2", "deleted"] },
  ].map((batch, index) => ({
    ...batch, status: "saved", id: String(index), generation: "generation",
    createdAt: "2026-09-24T00:00:00Z", observations: [],
  }));
  const records = ["old-1", "old-2", "middle", "new-1", "new-2"].map((id) => ({
    id,
    content: id,
    createdAt: "2026-09-24T00:00:00Z",
  }));
  const memory = {
    list: vi.fn(async () => ({ items: records, total: records.length })),
  } as unknown as LongTermMemoryService;
  expect(
    (await recentLearningMemories(memory, history)).map(({ id }) => id),
  ).toEqual(["new-2", "new-1", "middle"]);
});
