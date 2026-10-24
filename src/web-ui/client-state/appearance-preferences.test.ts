import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebClientStateStore } from "./store.js";
import { decodePreference, updatePreference } from "./preferences.js";
import { COLOR_PALETTES, PALETTE_PREFERENCE_KEY, savedColorPalette } from "../app/lib/color-palettes.js";
// @ts-expect-error Browser controller shared with storage tests.
import { createAppearanceController } from "../app/controllers/appearance-controller.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("saved palette survives a new store instance without changing other preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "abot-palette-")); roots.push(root);
  const store = new WebClientStateStore(root);
  const before = (await store.transaction((state) => ({ ...state.preferences }))).result;
  await store.transaction((state) => {
    updatePreference(state.preferences, { key: "abot-web.environmentId", before: null, value: "dev" });
    updatePreference(state.preferences, { key: PALETTE_PREFERENCE_KEY, before: null, value: "midnight" });
  });
  const result = await new WebClientStateStore(root).transaction((state) => state.preferences);
  expect(result.result).toEqual({ ...before, "abot-web.environmentId": "dev", [PALETTE_PREFERENCE_KEY]: "midnight" });
});

test("palette admission accepts declared ids and rejects arbitrary style content", () => {
  for (const palette of COLOR_PALETTES) expect(decodePreference(PALETTE_PREFERENCE_KEY, palette.id)).toBe(palette.id);
  for (const value of ["", "custom", "url(https://example.com)", "MIDNIGHT", 1, {}])
    expect(() => decodePreference(PALETTE_PREFERENCE_KEY, value)).toThrow();
  expect(decodePreference(PALETTE_PREFERENCE_KEY, null)).toBeUndefined();
});

function setup(initial: string | null = null) {
  const preferences: Record<string, string> = initial ? { [PALETTE_PREFERENCE_KEY]: initial } : {};
  const listeners = new Set<() => void>();
  const storage = {
    getItem: (key: string) => preferences[key] ?? null,
    snapshot: () => ({ preferences }),
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    setItem: vi.fn(async (key: string, value: string) => {
      updatePreference(preferences, { key, before: preferences[key] ?? null, value });
      for (const listener of listeners) listener();
    }),
  };
  const apply = vi.fn();
  const controller = createAppearanceController({ storage, applyPalette: apply });
  return { controller, storage, preferences, listeners, apply };
}

test("preview cancels without a write, while apply restores in a new controller", async () => {
  const { controller, storage, apply } = setup();
  expect(apply).toHaveBeenLastCalledWith("harbor");
  controller.open(); controller.select("midnight");
  expect(apply).toHaveBeenLastCalledWith("midnight");
  controller.close();
  expect(apply).toHaveBeenLastCalledWith("harbor");
  expect(storage.setItem).not.toHaveBeenCalled();
  controller.open(); controller.select("graphite");
  await controller.save();
  expect(controller.state()).toMatchObject({ savedId: "graphite", selectedId: "graphite", open: false, pending: false });
  const reopened = createAppearanceController({ storage, applyPalette: apply });
  expect(reopened.state().savedId).toBe("graphite");
});

test("a pending save cannot be overwritten or dismissed, and rejection restores acknowledged colors", async () => {
  const { controller, storage, apply } = setup("harbor");
  let reject!: (reason: Error) => void;
  storage.setItem.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  controller.open(); controller.select("midnight");
  const saving = controller.save();
  controller.select("graphite");
  expect(controller.close()).toBe(false);
  expect(controller.state()).toMatchObject({ open: true, selectedId: "midnight", pending: true });
  reject(new Error("These settings changed in another window."));
  await saving;
  expect(controller.state()).toMatchObject({ open: true, selectedId: "harbor", pending: false, error: "These settings changed in another window." });
  expect(apply).toHaveBeenLastCalledWith("harbor");
});

test("external acknowledged updates preserve an active preview and cancel uses latest saved choice", () => {
  const { controller, preferences, listeners, apply } = setup();
  controller.open(); controller.select("midnight");
  preferences[PALETTE_PREFERENCE_KEY] = "graphite";
  for (const listener of listeners) listener();
  expect(controller.state()).toMatchObject({ savedId: "graphite", selectedId: "midnight" });
  expect(apply).toHaveBeenLastCalledWith("midnight");
  controller.close();
  expect(apply).toHaveBeenLastCalledWith("graphite");
  preferences[PALETTE_PREFERENCE_KEY] = "harbor";
  for (const listener of listeners) listener();
  expect(apply).toHaveBeenLastCalledWith("harbor");
  controller.destroy();
  expect(listeners.size).toBe(0);
});

test("startup reads acknowledged state rather than an unconfirmed optimistic value", () => {
  expect(savedColorPalette({ getItem: () => "midnight", snapshot: () => ({ preferences: {} }) })).toBe("harbor");
});
