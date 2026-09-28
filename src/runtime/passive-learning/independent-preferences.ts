import type { PassiveLearningPreferences } from "./contracts.js";
import { validateWindow } from "./analysis-schedule.js";

export function normalizeIndependentLearningPreferences(
  input: Partial<PassiveLearningPreferences>, previous: PassiveLearningPreferences,
): Pick<PassiveLearningPreferences, "collectionWindow" | "proactiveEnabled" |
  "proactiveModelProfileId" | "proactiveIntervalMinutes" | "proactiveWindow" | "proactiveMessagesPerDay"> {
  if (input.proactiveEnabled !== undefined && typeof input.proactiveEnabled !== "boolean")
    throw new Error("invalid_learning_preferences");
  const profile = input.proactiveModelProfileId === undefined ? previous.proactiveModelProfileId : input.proactiveModelProfileId;
  if (profile != null && !isLearningProfileId(profile)) throw new Error("invalid_learning_model_profile");
  const collectionWindow = input.collectionWindow === undefined ? previous.collectionWindow ?? null : input.collectionWindow;
  const proactiveWindow = input.proactiveWindow === undefined ? previous.proactiveWindow ?? null : input.proactiveWindow;
  validateWindow(collectionWindow);
  validateWindow(proactiveWindow);
  const proactiveIntervalMinutes = input.proactiveIntervalMinutes ?? previous.proactiveIntervalMinutes ?? 60;
  const proactiveMessagesPerDay = input.proactiveMessagesPerDay ?? previous.proactiveMessagesPerDay ?? 2;
  if (!isBoundedPositiveInteger(proactiveIntervalMinutes, 1440)) throw new Error("invalid_learning_preferences");
  if (!isBoundedPositiveInteger(proactiveMessagesPerDay, 100)) throw new Error("invalid_learning_preferences");
  return {
    collectionWindow: collectionWindow ? Object.freeze({ ...collectionWindow }) : null,
    proactiveWindow: proactiveWindow ? Object.freeze({ ...proactiveWindow }) : null,
    proactiveEnabled: input.proactiveEnabled ?? previous.proactiveEnabled ?? false,
    ...(profile ? { proactiveModelProfileId: profile.trim() } : {}),
    proactiveIntervalMinutes, proactiveMessagesPerDay,
  };
}
function isLearningProfileId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!value.trim()) return false;
  return value.length <= 128;
}
function isBoundedPositiveInteger(value: unknown, maximum: number): boolean {
  if (typeof value !== "number") return false;
  if (!Number.isInteger(value)) return false;
  return value >= 1 && value <= maximum;
}
