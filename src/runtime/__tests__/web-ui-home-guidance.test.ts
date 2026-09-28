import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module.
import { selectHomeSuggestion } from "../../web-ui/app/components/home-guidance/suggestion-policy.js";
// @ts-expect-error Browser-only module.
import { createHomeGuidancePreferences, localReviewDay } from "../../web-ui/app/services/home-guidance-preferences.js";

const connection = { snapshot: { paired: false, readiness: { ready: false, route: "setup_required", environment: "wsl", platforms: ["windows"] } } };
const memory = { enabled: true, available: true };
const learning = { preferences: { enabled: false, processingPaused: true } };
const plugins = { plugins: [{ id: "memory", pluginEnabled: true, selectedCapabilityCount: 2 }] };

test("offers only one eligible next step and skips dismissed suggestions", () => {
  const input = { memory: { enabled: false }, connection, learning, plugins };
  expect(selectHomeSuggestion(input).id).toBe("memory");
  expect(selectHomeSuggestion({ ...input, dismissed: ["memory"] }).id).toBe("computer");
  expect(selectHomeSuggestion({ ...input, dismissed: ["memory", "computer"] })).toBeNull();
});
test("suggests the separate plugin only when passive memory is ready and tools are enabled", () => {
  const input = { memory, plugins, learning };
  expect(selectHomeSuggestion(input).id).toBe("plugin");
  expect(selectHomeSuggestion({ ...input, memory: { enabled: true, available: false } })).toBeNull();
  expect(selectHomeSuggestion({ ...input, plugins: { plugins: [{ ...plugins.plugins[0], blockedByGlobalPolicy: true }] } })).toBeNull();
  expect(selectHomeSuggestion({ ...input, plugins: { plugins: [{ ...plugins.plugins[0], selectedCapabilityCount: 0 }] } })).toBeNull();
});
test("does not duplicate the dedicated Co-worker section with a setup suggestion", () => {
  expect(selectHomeSuggestion({ memory, learning })).toBeNull();
  for (const preferences of [{ enabled: true }, { proactiveEnabled: true }, { modelProfileId: "local", processingPaused: false }]) {
    expect(selectHomeSuggestion({ memory, learning: { preferences } })).toBeNull();
  }
});
test.each([null, { ...connection, busy: true }, { ...connection, statusUnavailable: true }, { snapshot: { paired: true } }, { snapshot: { readiness: { ready: true, route: "native" } } }])("does not offer pairing on non-actionable readiness %j", (state) => {
  expect(selectHomeSuggestion({ connection: state })).toBeNull();
});
test("review receipts are isolated by environment, bounded, and contain no memory text", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) };
  const preferences = createHomeGuidancePreferences(storage);
  preferences.markOffered("dev", "2026-9-26");
  preferences.dismiss("dev", "memory");
  for (let i = 0; i < 220; i++) preferences.markReviewed("dev", { id: String(i), updatedAt: "date", content: "private text" });
  expect(preferences.wasOffered("prod", "2026-9-26")).toBe(false);
  expect(preferences.dismissed("prod")).toEqual([]);
  expect(preferences.hasReviewed("dev", { id: "219", updatedAt: "date" })).toBe(true);
  expect(preferences.hasReviewed("dev", { id: "219", updatedAt: "changed" })).toBe(false);
  const saved = [...values.values()][0]!;
  expect(JSON.parse(saved).reviewed).toHaveLength(200);
  expect(saved).not.toContain("private text");
  expect(localReviewDay(new Date(2026, 8, 26, 0, 1))).toBe("2026-9-26");
});
test("unavailable or malformed browser storage never blocks a dismissal", () => {
  const storage = { getItem: () => '{"reviewed":{},"dismissed":{}}', setItem: vi.fn(() => { throw new Error("full"); }) };
  const preferences = createHomeGuidancePreferences(storage);
  expect(preferences.hasReviewed("dev", { id: "a", updatedAt: "b" })).toBe(false);
  preferences.dismiss("dev", "memory");
  expect(preferences.dismissed("dev")).toEqual(["memory"]);
});

test("storage recovery keeps the latest receipt instead of a stale session fallback", () => {
  let value = "{}";
  const storage = { getItem: () => value, setItem: vi.fn((_key: string, next: string) => { value = next; }) };
  storage.setItem.mockImplementationOnce(() => { throw new Error("full"); });
  const preferences = createHomeGuidancePreferences(storage);
  preferences.dismiss("dev", "memory");
  preferences.markOffered("dev", "2026-9-26");
  expect(preferences.wasOffered("dev", "2026-9-26")).toBe(true);
  expect(preferences.dismissed("dev")).toEqual(["memory"]);
});
