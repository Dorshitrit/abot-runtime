import { captureSparkHomeAppearanceReference, type SparkHomeAppearanceReference } from "../../runtime/spark-home/appearance-reference.js";
import { COLOR_PALETTES, DEFAULT_PALETTE_ID, PALETTE_PREFERENCE_KEY } from "../app/lib/color-palettes.js";
import { WebClientStateStore } from "./store.js";

/** Only acknowledged Appearance data is projected; HOME does not modify workspace state. */
export function createSavedAppearanceReferenceReader(rootDir: string) {
  const store = new WebClientStateStore(rootDir);
  return async (): Promise<SparkHomeAppearanceReference | undefined> => {
    try {
      const { result } = await store.transaction(state => {
        const selected = state.preferences[PALETTE_PREFERENCE_KEY];
        const palette = COLOR_PALETTES.find(entry => entry.id === (selected ?? DEFAULT_PALETTE_ID));
        if (!palette) return undefined;
        return captureSparkHomeAppearanceReference({
          source: selected ? "saved_appearance" : "appearance_default", background: palette.background,
        });
      });
      return result;
    } catch { return undefined; }
  };
}
