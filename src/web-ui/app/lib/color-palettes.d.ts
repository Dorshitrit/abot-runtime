export const PALETTE_PREFERENCE_KEY: "abot-web.colorPalette";
export const DEFAULT_PALETTE_ID: "harbor";
export type ColorPaletteId = "harbor" | "midnight" | "graphite" | "charcoal" | "onyx" | "sand";
export interface ColorPalette {
  id: ColorPaletteId;
  name: string;
  description: string;
  background: string;
  panel: string;
  accent: string;
}
export const COLOR_PALETTES: ColorPalette[];
export function isColorPaletteId(value: unknown): value is ColorPaletteId;
export function savedColorPalette(storage: {
  getItem(key: string): string | null;
  snapshot?(): { preferences: Record<string, string> } | null;
}): ColorPaletteId;
