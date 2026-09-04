import type { normalizeWebSources } from "./web-sources.js";
import type { normalizeLegacyWebSources } from "./web-sources.js";

export declare function projectWebSourceEvent(
  message: Record<string, unknown>,
):
  | ReturnType<typeof normalizeWebSources>
  | ReturnType<typeof normalizeLegacyWebSources>;
