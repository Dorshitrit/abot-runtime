import { expect, test, vi } from "vitest";
import { createRuntimeWebClient } from "../app/services/runtime-web-client.js";
import { createLongTermMemoryController } from "../app/controllers/long-term-memory/controller.js";
// @ts-expect-error Internal browser storage.
import { createWorkspaceStateStorage } from "../app/services/workspace-state-storage.js";
// @ts-expect-error Internal review receipts.
import { createHomeGuidancePreferences } from "../app/services/home-guidance-preferences.js";
// @ts-expect-error Internal browser controller.
import { createDailyMemoryReview } from "../app/controllers/daily-memory-review.js";

test.each([
  ["Memory", 409], ["Memory", 500], ["daily review", 409], ["daily review", 500],
] as const)("%s completes deletion when receipt cleanup returns %s", async (surface, status) => {
  const record = { id: "memory", content: "Remembered", tags: [], origin: "passive_observation", createdAt: "2026-10-01", updatedAt: "new" };
  const initial = { version: 1, revision: 1, queue: "", preferences: {
    "abot-web.homeGuidance.prod": JSON.stringify({ reviewed: [{ id: record.id, updatedAt: "old" }] }),
  } };
  const onStorageError = vi.fn();
  const storageFetch = vi.fn(async (_url: string, input?: RequestInit) => input?.method === "POST"
    ? Response.json({ message: "Receipt storage unavailable" }, { status })
    : Response.json({ state: initial }));
  const storage = createWorkspaceStateStorage({ fetchImpl: storageFetch, onError: onStorageError });
  await storage.refresh();
  const preferences = createHomeGuidancePreferences(storage);
  let deleted = false;
  const fetchImpl = vi.fn(async (_url: Parameters<typeof fetch>[0], input?: RequestInit) => {
    if (input?.method === "DELETE") { deleted = true; return Response.json({ deleted: true }); }
    return Response.json({ items: deleted ? [] : [record], total: deleted ? 0 : 1, status: { enabled: true, available: true } });
  });
  const client = createRuntimeWebClient({ getConfig: () => ({}), getEnvironmentId: () => "prod", origin: "http://localhost", fetchImpl,
    onMemoryDeleted: (environment, id) => preferences.forgetReviewed(environment, id) });
  if (surface === "Memory") {
    const controller = createLongTermMemoryController({ client, getEnvironmentId: () => "prod", render: vi.fn() });
    await controller.load();
    expect(controller.snapshot().items).toHaveLength(1);
    await controller.deleteMemory(record.id);
    expect(controller.snapshot()).toMatchObject({ items: [], total: 0, error: "", message: "Memory deleted." });
  } else {
    const controller = createDailyMemoryReview({ client, preferences, getEnvironmentId: () => "prod", render: vi.fn() });
    controller.update(true, { automatic: false });
    await controller.loadForReview();
    expect(controller.snapshot().remaining).toBe(1);
    expect(await controller.decide("delete")).toBe(true);
    expect(controller.snapshot()).toMatchObject({ remaining: 0, error: "", busy: false });
  }
  expect(deleted).toBe(true);
  expect(onStorageError).toHaveBeenCalledOnce();
  expect(storage.error()?.message).toBe("Receipt storage unavailable");
  await expect(storage.flush()).rejects.toThrow("Receipt storage unavailable");
  expect(fetchImpl.mock.calls.filter(([, input]) => input?.method === "DELETE")).toHaveLength(1);
  expect(storageFetch.mock.calls.filter(([, input]) => input?.method === "POST")).toHaveLength(1);
});
