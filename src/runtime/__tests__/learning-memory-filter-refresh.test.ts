import { expect, test, vi } from "vitest";
import { createLongTermMemoryController } from "../../web-ui/app/controllers/long-term-memory/controller.js";

test("reopening the activity filter refreshes its canonical memory list", async () => {
  const status = { enabled: true, available: true };
  const record = {
    id: "new",
    content: "New activity fact",
    tags: [],
    origin: "passive_observation",
    createdAt: "2026-09-24T00:00:00Z",
    updatedAt: "2026-09-24T00:00:00Z",
  };
  const listLongTermMemories = vi.fn(async () => ({
    items: [record],
    total: 1,
    status,
  }));
  listLongTermMemories.mockResolvedValueOnce({ items: [], total: 0, status });
  const controller = createLongTermMemoryController({
    getEnvironmentId: () => "dev",
    render() {},
    client: {
      listLongTermMemories,
      loadLongTermMemoryStatus: async () => ({ status }),
      searchLongTermMemories: async () => ({ items: [], total: 0 }),
      createLongTermMemory: async () => ({ record }),
      updateLongTermMemory: async () => ({ record }),
      deleteLongTermMemory: async () => ({ deleted: true }),
    },
  });
  await controller.setOriginFilter("passive_observation");
  await controller.setOriginFilter("passive_observation");
  expect(listLongTermMemories).toHaveBeenCalledTimes(2);
  expect(
    controller.snapshot().items.map(({ id }: { id: string }) => id),
  ).toEqual(["new"]);
});
