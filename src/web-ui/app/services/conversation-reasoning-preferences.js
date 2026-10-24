import { isReasoningPreference } from "../lib/reasoning-preference.js";

export const REASONING_PREFERENCES_KEY = "abot-web.reasoningPreferences";
export function createConversationReasoningPreferences(storage) {
  const keyFor = (scope, profileId) => JSON.stringify([scope.environmentId, scope.sessionId || "", profileId]);
  function read() {
    const raw = storage?.getItem(REASONING_PREFERENCES_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved thinking preferences.");
    return value;
  }
  return {
    loadReasoningPreference(scope, profileId) {
      const value = read()[keyFor(scope, profileId)];
      if (value === undefined) return undefined;
      if (!isReasoningPreference(value) || value.profileId !== profileId) throw new Error("Invalid saved thinking preference.");
      return { ...value };
    },
    saveReasoningPreference(scope, profileId, preference) {
      if (preference !== undefined && (!isReasoningPreference(preference) || preference.profileId !== profileId))
        throw new Error("Thinking preference must match the selected model.");
      const values = read();
      const key = keyFor(scope, profileId);
      if (preference === undefined) delete values[key];
      else values[key] = { ...preference };
      return storage.setItem(REASONING_PREFERENCES_KEY, JSON.stringify(values));
    },
  };
}
