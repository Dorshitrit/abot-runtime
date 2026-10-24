import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebClientStateStore } from "./store.js";
import { decodePreference, updatePreference } from "./preferences.js";
import { PALETTE_PREFERENCE_KEY } from "../app/lib/color-palettes.js";
import { DEFAULT_NAVIGATION_MODE, NAVIGATION_PREFERENCE_KEY, savedNavigationMode } from "../app/lib/navigation-display.js";
// @ts-expect-error Browser controller shared with storage tests.
import { createAppearanceController } from "../app/controllers/appearance-controller.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function setup(initial: Record<string, string> = {}) {
  const preferences = { ...initial };
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const acknowledge = (key: string, value: string) => {
    updatePreference(preferences, { key, before: preferences[key] ?? null, value });
    notify();
  };
  const storage = {
    getItem: (key: string) => preferences[key] ?? null,
    snapshot: () => ({ preferences }),
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    setItem: vi.fn(async (key: string, value: string) => { acknowledge(key, value); }),
  };
  const applyPalette = vi.fn();
  const applyNavigationMode = vi.fn();
  const controller = createAppearanceController({ storage, applyPalette, applyNavigationMode });
  return { controller, storage, preferences, listeners, notify, acknowledge, applyPalette, applyNavigationMode };
}

test("navigation preference survives a new durable store without changing other preferences", async () => {
  const root = await mkdtemp(join(tmpdir(), "abot-navigation-")); roots.push(root);
  const store = new WebClientStateStore(root);
  const before = (await store.transaction((state) => ({ ...state.preferences }))).result;
  await store.transaction((state) => {
    updatePreference(state.preferences, { key: PALETTE_PREFERENCE_KEY, before: null, value: "onyx" });
    updatePreference(state.preferences, { key: NAVIGATION_PREFERENCE_KEY, before: null, value: "icons" });
  });
  const restored = (await new WebClientStateStore(root).transaction((state) => state.preferences)).result;
  expect(restored).toEqual({ ...before, [PALETTE_PREFERENCE_KEY]: "onyx", [NAVIGATION_PREFERENCE_KEY]: "icons" });
});

test("navigation admission permits only declared modes or clearing the preference", () => {
  for (const mode of ["labels", "icons"]) expect(decodePreference(NAVIGATION_PREFERENCE_KEY, mode)).toBe(mode);
  for (const value of ["", "compact", "ICONS", "display:none", 1, false, {}])
    expect(() => decodePreference(NAVIGATION_PREFERENCE_KEY, value)).toThrow();
  expect(decodePreference(NAVIGATION_PREFERENCE_KEY, null)).toBeUndefined();
});

test("legacy preferences keep labels and startup ignores unconfirmed optimistic values", () => {
  expect(DEFAULT_NAVIGATION_MODE).toBe("labels");
  expect(savedNavigationMode({ getItem: () => "icons", snapshot: () => ({ preferences: {} }) })).toBe("labels");
  expect(savedNavigationMode({ getItem: () => "unknown" })).toBe("labels");
  expect(savedNavigationMode({ getItem: () => "icons" })).toBe("icons");
  const { controller, applyNavigationMode } = setup({ [PALETTE_PREFERENCE_KEY]: "onyx" });
  expect(controller.state()).toMatchObject({ savedId: "onyx", savedNavigationMode: "labels", selectedNavigationMode: "labels" });
  expect(applyNavigationMode).toHaveBeenLastCalledWith("labels");
});

test("palette and navigation preview together, cancel without writing, and apply survives reopening", async () => {
  const { controller, storage, applyPalette, applyNavigationMode } = setup();
  controller.open(); controller.select("onyx"); controller.selectNavigationMode("icons");
  expect(applyPalette).toHaveBeenLastCalledWith("onyx");
  expect(applyNavigationMode).toHaveBeenLastCalledWith("icons");
  controller.close();
  expect(applyPalette).toHaveBeenLastCalledWith("harbor");
  expect(applyNavigationMode).toHaveBeenLastCalledWith("labels");
  expect(storage.setItem).not.toHaveBeenCalled();
  controller.open(); controller.select("onyx"); controller.selectNavigationMode("icons");
  await controller.save();
  expect(controller.state()).toMatchObject({
    savedId: "onyx", selectedId: "onyx", savedNavigationMode: "icons", selectedNavigationMode: "icons", open: false, pending: false,
  });
  const reopened = createAppearanceController({ storage, applyPalette, applyNavigationMode });
  expect(reopened.state()).toMatchObject({ savedId: "onyx", savedNavigationMode: "icons" });
  controller.destroy(); reopened.destroy();
});

test("changing navigation alone does not rewrite an unchanged palette", async () => {
  const { controller, storage } = setup({ [PALETTE_PREFERENCE_KEY]: "onyx" });
  controller.open(); controller.selectNavigationMode("icons"); await controller.save();
  expect(storage.setItem.mock.calls).toEqual([[NAVIGATION_PREFERENCE_KEY, "icons"]]);
  controller.open(); await controller.save();
  expect(storage.setItem).toHaveBeenCalledTimes(1);
});

test("pending apply captures both choices and blocks another apply, edits, or dismissal", async () => {
  const { controller, storage, acknowledge } = setup();
  let release!: () => void;
  storage.setItem.mockImplementationOnce((key: string, value: string) => new Promise<void>((resolve) => {
    release = () => { acknowledge(key, value); resolve(); };
  }));
  controller.open(); controller.select("onyx"); controller.selectNavigationMode("icons");
  const saving = controller.save();
  controller.select("midnight"); controller.selectNavigationMode("labels");
  await controller.save();
  expect(controller.close()).toBe(false);
  expect(controller.state()).toMatchObject({ selectedId: "onyx", selectedNavigationMode: "icons", pending: true, open: true });
  expect(storage.setItem).toHaveBeenCalledTimes(1);
  release(); await saving;
  expect(storage.setItem.mock.calls).toEqual([[PALETTE_PREFERENCE_KEY, "onyx"], [NAVIGATION_PREFERENCE_KEY, "icons"]]);
  expect(controller.state()).toMatchObject({ selectedId: "onyx", selectedNavigationMode: "icons", pending: false, open: false });
});

test("partial save failure displays actual acknowledged settings and retries only the unsaved choice", async () => {
  const { controller, storage, acknowledge, applyPalette, applyNavigationMode } = setup();
  storage.setItem.mockImplementationOnce(async (key: string, value: string) => { acknowledge(key, value); });
  storage.setItem.mockRejectedValueOnce(new Error("Navigation settings could not be saved"));
  controller.open(); controller.select("onyx"); controller.selectNavigationMode("icons"); await controller.save();
  expect(controller.state()).toMatchObject({
    savedId: "onyx", selectedId: "onyx", savedNavigationMode: "labels", selectedNavigationMode: "labels",
    pending: false, open: true, error: "Navigation settings could not be saved",
  });
  expect(applyPalette).toHaveBeenLastCalledWith("onyx");
  expect(applyNavigationMode).toHaveBeenLastCalledWith("labels");
  controller.selectNavigationMode("icons"); await controller.save();
  expect(storage.setItem.mock.calls).toEqual([
    [PALETTE_PREFERENCE_KEY, "onyx"], [NAVIGATION_PREFERENCE_KEY, "icons"], [NAVIGATION_PREFERENCE_KEY, "icons"],
  ]);
  expect(controller.state()).toMatchObject({ savedNavigationMode: "icons", open: false, error: "" });
});

test("external updates preserve a different preview independently for each field", () => {
  const { controller, preferences, notify, applyPalette, applyNavigationMode } = setup();
  controller.open(); controller.select("midnight");
  preferences[PALETTE_PREFERENCE_KEY] = "onyx"; preferences[NAVIGATION_PREFERENCE_KEY] = "icons"; notify();
  expect(controller.state()).toMatchObject({ savedId: "onyx", selectedId: "midnight", savedNavigationMode: "icons", selectedNavigationMode: "icons" });
  expect(applyPalette).toHaveBeenLastCalledWith("midnight");
  expect(applyNavigationMode).toHaveBeenLastCalledWith("icons");
  controller.close();
  expect(applyPalette).toHaveBeenLastCalledWith("onyx");
  controller.open(); controller.selectNavigationMode("labels");
  preferences[PALETTE_PREFERENCE_KEY] = "graphite"; notify();
  expect(controller.state()).toMatchObject({ savedId: "graphite", selectedId: "graphite", savedNavigationMode: "icons", selectedNavigationMode: "labels" });
  expect(applyNavigationMode).toHaveBeenLastCalledWith("labels");
  controller.close();
  expect(applyNavigationMode).toHaveBeenLastCalledWith("icons");
});

test("navigation rejects invalid or closed previews and destroy releases subscriptions", () => {
  const { controller, applyNavigationMode, listeners, preferences, notify } = setup();
  controller.selectNavigationMode("icons");
  expect(applyNavigationMode).toHaveBeenCalledTimes(1);
  controller.open(); controller.selectNavigationMode("unsupported");
  expect(controller.state().selectedNavigationMode).toBe("labels");
  preferences[NAVIGATION_PREFERENCE_KEY] = "icons"; notify();
  expect(applyNavigationMode).toHaveBeenLastCalledWith("icons");
  controller.selectNavigationMode("labels"); controller.destroy();
  expect(applyNavigationMode).toHaveBeenLastCalledWith("icons");
  expect(listeners.size).toBe(0);
});
