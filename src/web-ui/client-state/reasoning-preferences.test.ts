import { expect, test } from "vitest";
import { decodePreference, updatePreference } from "./preferences.js";
import { createConversationReasoningPreferences, REASONING_PREFERENCES_KEY } from "../app/services/conversation-reasoning-preferences.js";

test.each([0, 192])("thinking budget %i persists separately per environment, conversation and profile", (budgetTokens) => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) || null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const preferences = createConversationReasoningPreferences(storage);
  const scope = { environmentId: "prod", sessionId: "chat" };
  const selected = { profileId: "gemma", mode: "budget" as const, budgetTokens };
  preferences.saveReasoningPreference(scope, "gemma", selected);
  selected.budgetTokens = 999;
  expect(preferences.loadReasoningPreference(scope, "gemma")).toEqual({ profileId: "gemma", mode: "budget", budgetTokens });
  expect(decodePreference(REASONING_PREFERENCES_KEY, saved.get(REASONING_PREFERENCES_KEY))).toEqual({
    '["prod","chat","gemma"]': { profileId: "gemma", mode: "budget", budgetTokens },
  });
  expect(preferences.loadReasoningPreference(scope, "other")).toBeUndefined();
  expect(preferences.loadReasoningPreference({ ...scope, sessionId: "another" }, "gemma")).toBeUndefined();
  expect(preferences.loadReasoningPreference({ ...scope, environmentId: "dev" }, "gemma")).toBeUndefined();
  expect(createConversationReasoningPreferences(storage).loadReasoningPreference(scope, "gemma")).toEqual({
    profileId: "gemma", mode: "budget", budgetTokens,
  });
  preferences.saveReasoningPreference(scope, "gemma", undefined);
  expect(preferences.loadReasoningPreference(scope, "gemma")).toBeUndefined();
});

test.each([null, { profileId: "model", mode: "budget", budgetTokens: -1 },
  { profileId: "model", mode: "budget", budgetTokens: 1.5 },
  { profileId: "model", mode: "budget", budgetTokens: 2147483648 },
  { profileId: "model", mode: "off", budgetTokens: 1 },
  { profileId: "wrong", mode: "off" },
])("client-state rejects malformed or mismatched saved preferences: %j", (preference) => {
  expect(() => decodePreference(REASONING_PREFERENCES_KEY, JSON.stringify({
    '["prod","chat","model"]': preference,
  }))).toThrow("Invalid workspace preferences");
});

test("independent windows merge different conversation preferences and reject competing changes", () => {
  const preferences: Record<string, string> = {};
  const one = '["prod","one","model"]', two = '["prod","two","model"]';
  const off = { profileId: "model", mode: "off" };
  const budget = { profileId: "model", mode: "budget", budgetTokens: 64 };
  updatePreference(preferences, { key: REASONING_PREFERENCES_KEY, before: null, value: JSON.stringify({ [one]: off }) });
  updatePreference(preferences, { key: REASONING_PREFERENCES_KEY, before: null, value: JSON.stringify({ [two]: budget }) });
  expect(JSON.parse(preferences[REASONING_PREFERENCES_KEY])).toEqual({ [one]: off, [two]: budget });
  expect(() => updatePreference(preferences, { key: REASONING_PREFERENCES_KEY, before: null, value: JSON.stringify({ [one]: budget }) })).toThrow();
});
