import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { createDailyMemoryReview } from "../../web-ui/app/controllers/daily-memory-review.js";
// @ts-expect-error Browser-only module.
import { createHomeGuidancePreferences } from "../../web-ui/app/services/home-guidance-preferences.js";

const record = (id: string) => ({ id, content: `Memory ${id}`, origin: "passive_observation", createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z" });
const flush = async () => { await new Promise((resolve) => setImmediate(resolve)); };
function harness(items = [record("a"), record("b")]) {
  let environment = "dev";
  const storage = new Map<string, string>();
  const preferences = createHomeGuidancePreferences({ getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) });
  const client = {
    listLongTermMemories: vi.fn(async (input) => ({ total: items.length, items: input.limit === 1 ? items.slice(0, 1) : items, status: { enabled: true, available: true } })),
    deleteLongTermMemory: vi.fn(async () => ({ deleted: true })),
  };
  const render = vi.fn();
  const controller = createDailyMemoryReview({ client, preferences, getEnvironmentId: () => environment, render, now: () => new Date(2026, 8, 26) });
  return { controller, client, preferences, render, setEnvironment: (value: string) => { environment = value; } };
}
test("loads a bounded recent set once per entry and offers once per day without polling", async () => {
  const f = harness(Array.from({ length: 80 }, (_, index) => record(String(index))));
  f.controller.update(false);
  expect(f.client.listLongTermMemories).not.toHaveBeenCalled();
  f.controller.update(true);
  await flush();
  expect(f.client.listLongTermMemories).toHaveBeenCalledTimes(2);
  expect(f.client.listLongTermMemories.mock.calls[1]![0]).toMatchObject({ environmentId: "dev", limit: 50, offset: 30, origin: "passive_observation" });
  expect(f.controller.snapshot().items).toHaveLength(10);
  expect(f.controller.markOffered()).toBe(true);
  expect(f.controller.markOffered()).toBe(false);
  f.controller.update(true);
  f.controller.update(false);
  f.controller.update(true);
  await flush();
  expect(f.client.listLongTermMemories).toHaveBeenCalledTimes(4);
  expect(f.controller.markOffered()).toBe(false);
});
test("Keep records a local receipt; Delete uses only the selected environment and memory ID", async () => {
  const f = harness();
  f.controller.update(true);
  await flush();
  await f.controller.decide("keep");
  expect(f.client.deleteLongTermMemory).not.toHaveBeenCalled();
  expect(f.preferences.hasReviewed("dev", record("a"))).toBe(true);
  await f.controller.decide("delete");
  expect(f.client.deleteLongTermMemory).toHaveBeenCalledWith({ environmentId: "dev", id: "b" });
  expect(f.controller.snapshot().remaining).toBe(0);
});
test("failed deletion stays on the card and never marks it reviewed", async () => {
  const f = harness();
  f.client.deleteLongTermMemory.mockRejectedValue(new Error("offline"));
  f.controller.update(true);
  await flush();
  expect(await f.controller.decide("delete")).toBe(false);
  expect(f.controller.snapshot().index).toBe(0);
  expect(f.controller.snapshot().error).not.toBe("");
  expect(f.preferences.hasReviewed("dev", record("a"))).toBe(false);
});
test("empty and failed reads do not retry on every state update", async () => {
  const f = harness([]);
  f.controller.update(true);
  await flush();
  f.controller.update(true);
  expect(f.client.listLongTermMemories).toHaveBeenCalledOnce();
  expect(f.controller.markOffered()).toBe(false);
});
test("ignores stale environment responses and aborts the optional read when Home leaves", async () => {
  const f = harness();
  let finish!: (value: any) => void;
  f.client.listLongTermMemories.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  f.controller.update(true);
  const signal = f.client.listLongTermMemories.mock.calls[0]![0].signal;
  f.setEnvironment("prod");
  f.controller.update(false);
  expect(signal.aborted).toBe(true);
  finish({ total: 5, items: [record("old")] });
  await flush();
  expect(f.controller.snapshot().items).toEqual([]);
  expect(f.client.listLongTermMemories).toHaveBeenCalledOnce();
});
test("includes Co-worker sources and skips unrelated or already reviewed records", async () => {
  const f = harness([{ ...record("manual"), origin: "web_ui" }, record("seen"), record("new")]);
  f.preferences.markReviewed("dev", record("seen"));
  f.controller.update(true);
  await flush();
  expect(f.controller.snapshot().items.map((item: any) => item.id)).toEqual(["new"]);
});

test("reviews existing chat memories reinforced by Co-worker without changing their origin", async () => {
  const f = harness([{ ...record("shared"), origin: "passive_response", observationSources: [{ batchId: "b" }] } as any]);
  f.controller.update(true);
  await flush();
  expect(f.controller.snapshot().items[0].id).toBe("shared");
  await f.controller.decide("keep");
  expect(f.client.deleteLongTermMemory).not.toHaveBeenCalled();
});

test("manual review works after today's invitation and still excludes reviewed records", async () => {
  const f = harness();
  f.preferences.markOffered("dev", "2026-9-26");
  f.preferences.markReviewed("dev", record("a"));
  f.controller.update(true);
  await flush();
  expect(f.client.listLongTermMemories).toHaveBeenCalledTimes(2);
  expect(await f.controller.loadForReview()).toBe(true);
  expect(f.client.listLongTermMemories).toHaveBeenCalledTimes(2);
  expect(f.controller.snapshot().items.map((item: any) => item.id)).toEqual(["b"]);
  expect(f.controller.markOffered()).toBe(false);
});

test("an explicit review reports failed reads and supports an empty result", async () => {
  const f = harness([]);
  f.controller.update(true, { automatic: false });
  f.client.listLongTermMemories.mockRejectedValueOnce(new Error("offline"));
  expect(await f.controller.loadForReview()).toBe(true);
  expect(f.controller.snapshot().error).toContain("could not be loaded");
  expect(await f.controller.loadForReview()).toBe(true);
  expect(f.controller.snapshot()).toMatchObject({ items: [], remaining: 0, error: "" });
});

test("manual opening shares an automatic read already in flight", async () => {
  const f = harness();
  let finish!: (value: any) => void;
  f.client.listLongTermMemories.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  f.controller.update(true);
  const opening = f.controller.loadForReview();
  expect(f.client.listLongTermMemories).toHaveBeenCalledOnce();
  finish({ total: 2, items: [record("a")] });
  expect(await opening).toBe(true);
  expect(f.client.listLongTermMemories).toHaveBeenCalledTimes(2);
});

test.each([
  { manual: true, status: { enabled: false, available: true } },
  { manual: true, status: { enabled: true, available: false } },
  { manual: false, status: { enabled: false, available: true } },
  { manual: false, status: { enabled: true, available: false } },
])("rejects records that become unavailable after the count request: %j", async ({ manual, status }) => {
  const f = harness();
  f.client.listLongTermMemories
    .mockResolvedValueOnce({ total: 1, items: [record("a")], status: { enabled: true, available: true } })
    .mockResolvedValueOnce({ total: 1, items: [record("a")], status });
  f.controller.update(true, { automatic: !manual });
  if (manual) expect(await f.controller.loadForReview()).toBe(true);
  await flush();
  expect(f.controller.snapshot()).toMatchObject({ items: [], remaining: 0 });
  expect(Boolean(f.controller.snapshot().error)).toBe(manual);
  expect(f.render.mock.calls.every(([snapshot]) => snapshot.items.length === 0)).toBe(true);
  expect(f.controller.markOffered()).toBe(false);
  expect(await f.controller.decide("delete")).toBe(false);
  expect(f.client.deleteLongTermMemory).not.toHaveBeenCalled();
  f.controller.update(true);
  await flush();
  expect(f.client.listLongTermMemories).toHaveBeenCalledTimes(2);
});
