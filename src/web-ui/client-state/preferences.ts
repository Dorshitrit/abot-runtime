import { isDeepStrictEqual } from "node:util";
import { ClientStateError, type ClientPreferences } from "./contracts.js";
import { assertPreferenceShape, isPreferenceObject as isObject } from "./preference-shapes.js";

const scalarKeys = new Set(["abot-web.environmentId", "abot-web.lastToolPermissionMode"]);
const jsonKeys = new Set([
  "abot-web.pinnedSessions", "abot-web.currentSessionByEnvironment", "abot-web.sessionModes",
  "abot-web.sessionModels", "abot-web.lastModelByEnvironment", "abot-web.sessionSidebarByEnvironment",
  "abot.spark.launcher.position.v1",
]);
const modes = new Set(["ask", "full_access", "full_plus"]);

function assertBoundedJson(value: unknown, depth = 0): void {
  if (depth > 8) throw new ClientStateError("invalid_preferences", "Workspace preferences are too deeply nested.");
  if (!value || typeof value !== "object") return;
  for (const child of Object.values(value)) {
    assertBoundedJson(child, depth + 1);
  }
}

function isGuidanceKey(key: string): boolean {
  // encodeURIComponent leaves these punctuation characters unescaped. The
  // request and state byte limits bound keys without restricting profile IDs.
  return /^abot-web\.homeGuidance\.(?:[A-Za-z0-9_.!~*'()-]|%[0-9A-Fa-f]{2})+$/.test(key);
}

export function decodePreference(key: string, value: unknown): unknown {
  if (!scalarKeys.has(key) && !jsonKeys.has(key) && !isGuidanceKey(key))
    throw new ClientStateError("invalid_preferences", "Unknown workspace preference.");
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length > 524_288)
    throw new ClientStateError("invalid_preferences", "Invalid workspace preference value.");
  if (scalarKeys.has(key)) {
    if (key.endsWith("lastToolPermissionMode") && !modes.has(value))
      throw new ClientStateError("invalid_preferences", "Select Ask, Full or Full+.");
    return value;
  }
  let decoded: unknown;
  try { decoded = JSON.parse(value); }
  catch { throw new ClientStateError("invalid_preferences", "Workspace preferences must contain JSON."); }
  assertBoundedJson(decoded);
  assertPreferenceShape(key, decoded);
  return decoded;
}

function ownPreferenceField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function mergeChangedFields(before: unknown, after: unknown, current: unknown): unknown {
  if (isDeepStrictEqual(before, after)) return current;
  if (before === undefined && isObject(after) && isObject(current))
    return mergeChangedFields({}, after, current);
  if (isObject(before) && isObject(after) && isObject(current)) {
    const result: Record<string, unknown> = Object.assign(Object.create(null), current);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const next = mergeChangedFields(ownPreferenceField(before, key), ownPreferenceField(after, key), ownPreferenceField(current, key));
      if (next === undefined) delete result[key];
      else result[key] = next;
    }
    return result;
  }
  if (!isDeepStrictEqual(current, before) && !isDeepStrictEqual(current, after))
    throw new ClientStateError("preferences_changed", "These settings changed in another window. Reload before saving again.", 409);
  return after;
}

export function updatePreference(preferences: ClientPreferences, input: Record<string, unknown>): void {
  const key = typeof input.key === "string" ? input.key : "";
  const before = decodePreference(key, input.before);
  const after = decodePreference(key, input.value);
  const current = decodePreference(key, preferences[key] ?? null);
  const merged = mergeChangedFields(before, after, current);
  if (merged === undefined) { delete preferences[key]; return; }
  const value = scalarKeys.has(key) ? String(merged) : JSON.stringify(merged);
  decodePreference(key, value);
  preferences[key] = value;
}
