import { isReasoningPreference } from "../app/lib/reasoning-preference.js";

export function isReasoningPreferenceMap(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, preference]) => {
    if (!isReasoningPreference(preference)) return false;
    try {
      const scope: unknown = JSON.parse(key);
      return Array.isArray(scope) && key === JSON.stringify(scope) && scope.length === 3
        && typeof scope[0] === "string" && Boolean(scope[0].trim())
        && typeof scope[1] === "string" && scope[2] === preference.profileId;
    } catch { return false; }
  });
}
