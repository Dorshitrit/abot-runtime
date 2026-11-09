import type { SparkHomeService } from "./contracts.js";
import type { SparkHomeSettingsService } from "./settings/contracts.js";
import type { SparkHomeGenerationService } from "./generation/contracts.js";
import type { SparkHomePreferencesService } from "./preferences.js";
import type { SparkHomeAppearanceReference } from "./appearance-reference.js";

/** Feature services are separate from the ordinary request handler and its options. */
export type SparkHomeApplicationServices = Readonly<{
  sparkHome?: SparkHomeService;
  sparkHomeSettings?: SparkHomeSettingsService;
  sparkHomeGeneration?: SparkHomeGenerationService;
  sparkHomePreferences?: SparkHomePreferencesService;
}>;
export type SparkHomeAppearanceOptions = Readonly<{
  sparkHomeAppearance?: () => Promise<SparkHomeAppearanceReference | undefined>;
}>;
