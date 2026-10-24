import { createAppearanceController } from "./controllers/appearance-controller.js";
import { createAppearanceDialog } from "./components/appearance-dialog.js";
import { COLOR_PALETTES } from "./lib/color-palettes.js";

export function createAppearanceFeature({ mount, storage }) {
  if (!mount) return;
  const doc = mount.ownerDocument;
  let view;
  const controller = createAppearanceController({
    storage,
    applyNavigationMode(mode) { doc.documentElement.dataset.navigation = mode; },
    applyPalette(id) {
      doc.documentElement.dataset.palette = id;
      const theme = doc.querySelector('meta[name="theme-color"]');
      if (theme) theme.content = COLOR_PALETTES.find((palette) => palette.id === id).background;
    },
    onChange: (state) => view?.render(state),
  });
  view = createAppearanceDialog({
    mount,
    onOpen: () => controller.open(),
    onSelect: (id) => controller.select(id),
    onSelectNavigation: (mode) => controller.selectNavigationMode(mode),
    onSave: () => { void controller.save(); },
    onClose: () => controller.close(),
  });
  return { destroy() { controller.destroy(); view.destroy(); } };
}
