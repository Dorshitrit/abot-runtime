export const PALETTE_PREFERENCE_KEY = "abot-web.colorPalette";
export const DEFAULT_PALETTE_ID = "harbor";
export const COLOR_PALETTES = [
  { id: "harbor", name: "Harbor", description: "Deep blue · sea glass", background: "#090f17", panel: "#0d151e", accent: "#82d4c2" },
  { id: "midnight", name: "Midnight", description: "Near black · ice blue", background: "#090b10", panel: "#10131b", accent: "#97bdff" },
  { id: "graphite", name: "Graphite", description: "Soft charcoal · lilac", background: "#101012", panel: "#18181c", accent: "#c4b5ed" },
  { id: "charcoal", name: "Onyx Soft", description: "Soft black · silver", background: "#0d0d0d", panel: "#151515", accent: "#c7c7c7" },
  { id: "onyx", name: "Onyx", description: "Pure black · soft white", background: "#070707", panel: "#101010", accent: "#d4d4d4" },
  { id: "sand", name: "Onyx Steel", description: "Cool black · steel", background: "#080b0e", panel: "#101519", accent: "#b5c6d2" },
];

export function isColorPaletteId(value) {
  return COLOR_PALETTES.some((palette) => palette.id === value);
}

export function savedColorPalette(storage) {
  const acknowledged = storage.snapshot?.();
  const value = acknowledged ? acknowledged.preferences[PALETTE_PREFERENCE_KEY] : storage.getItem(PALETTE_PREFERENCE_KEY);
  return isColorPaletteId(value) ? value : DEFAULT_PALETTE_ID;
}
