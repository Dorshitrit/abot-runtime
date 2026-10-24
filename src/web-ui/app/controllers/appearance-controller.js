import { isColorPaletteId, PALETTE_PREFERENCE_KEY, savedColorPalette } from "../lib/color-palettes.js";
import { isNavigationMode, NAVIGATION_PREFERENCE_KEY, savedNavigationMode } from "../lib/navigation-display.js";

export function createAppearanceController({ storage, applyPalette, applyNavigationMode = () => {}, onChange = () => {} }) {
  let savedId = savedColorPalette(storage);
  let selectedId = savedId;
  let savedNavigation = savedNavigationMode(storage);
  let selectedNavigation = savedNavigation;
  let open = false;
  let pending = false;
  let error = "";
  const state = () => ({ savedId, selectedId, savedNavigationMode: savedNavigation, selectedNavigationMode: selectedNavigation, open, pending, error });
  const render = () => onChange(state());
  const canPreviewAppearance = () => open && !pending;
  applyPalette(savedId);
  applyNavigationMode(savedNavigation);

  function restoreAcknowledgedAppearance() {
    savedId = savedColorPalette(storage);
    selectedId = savedId;
    savedNavigation = savedNavigationMode(storage);
    selectedNavigation = savedNavigation;
    applyPalette(savedId);
    applyNavigationMode(savedNavigation);
  }

  const unsubscribe = storage.subscribe?.(() => {
    const previousSavedId = savedId;
    const previousSavedNavigation = savedNavigation;
    savedId = savedColorPalette(storage);
    savedNavigation = savedNavigationMode(storage);
    if (followsSavedAppearance(open, selectedId, previousSavedId)) {
      selectedId = savedId;
      applyPalette(savedId);
    }
    if (followsSavedAppearance(open, selectedNavigation, previousSavedNavigation)) {
      selectedNavigation = savedNavigation;
      applyNavigationMode(savedNavigation);
    }
    render();
  });

  return {
    state,
    open() {
      if (open) return;
      restoreAcknowledgedAppearance();
      error = "";
      open = true;
      render();
    },
    select(id) {
      if (!canPreviewAppearance()) return;
      if (!isColorPaletteId(id)) return;
      selectedId = id;
      error = "";
      applyPalette(id);
      render();
    },
    selectNavigationMode(mode) {
      if (!canPreviewAppearance()) return;
      if (!isNavigationMode(mode)) return;
      selectedNavigation = mode;
      error = "";
      applyNavigationMode(mode);
      render();
    },
    close() {
      if (pending) return false;
      open = false;
      restoreAcknowledgedAppearance();
      render();
      return true;
    },
    async save() {
      if (!canPreviewAppearance()) return;
      const paletteToSave = selectedId;
      const navigationToSave = selectedNavigation;
      pending = true;
      error = "";
      render();
      try {
        if (paletteToSave !== savedColorPalette(storage))
          await storage.setItem(PALETTE_PREFERENCE_KEY, paletteToSave);
        if (navigationToSave !== savedNavigationMode(storage))
          await storage.setItem(NAVIGATION_PREFERENCE_KEY, navigationToSave);
        open = false;
      } catch (failure) {
        error = failure?.message || "Could not save appearance settings. Reload and try again.";
      } finally {
        pending = false;
        restoreAcknowledgedAppearance();
        render();
      }
    },
    destroy() {
      unsubscribe?.();
      restoreAcknowledgedAppearance();
    },
  };
}

function followsSavedAppearance(open, selected, previouslySaved) {
  return !open || selected === previouslySaved;
}
