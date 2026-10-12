import { ClientStateError } from "./contracts.js";

const modes = new Set(["ask", "full_access", "full_plus"]);
export function isPreferenceObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function hasOnlyFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}
function isSessionMode(value: unknown): boolean {
  if (!isPreferenceObject(value)) return false;
  if (!hasOnlyFields(value, ["toolPermissionMode", "savedAt"])) return false;
  if (typeof value.toolPermissionMode !== "string" || !modes.has(value.toolPermissionMode)) return false;
  return Number.isFinite(value.savedAt);
}
function isSidebarPreference(value: unknown): boolean {
  if (!isPreferenceObject(value)) return false;
  if (!hasOnlyFields(value, ["archivedSessionIds", "orderedSessionIds"])) return false;
  return isStringList(value.archivedSessionIds) && isStringList(value.orderedSessionIds);
}
function isLauncherPosition(value: unknown): boolean {
  if (!isPreferenceObject(value)) return false;
  if (!hasOnlyFields(value, ["x", "y"])) return false;
  return Number.isFinite(value.x) && Number.isFinite(value.y);
}
function isGuidancePreference(value: unknown): boolean {
  if (!isPreferenceObject(value)) return false;
  if (!hasOnlyFields(value, ["offeredOn", "dismissed", "reviewed"])) return false;
  if (value.offeredOn !== undefined && typeof value.offeredOn !== "string") return false;
  if (value.dismissed !== undefined && (!isStringList(value.dismissed) || value.dismissed.length > 8)) return false;
  if (value.reviewed === undefined) return true;
  if (!Array.isArray(value.reviewed) || value.reviewed.length > 200) return false;
  const seen = new Set<string>();
  for (const item of value.reviewed) {
    if (!isPreferenceObject(item)) return false;
    if (!hasOnlyFields(item, ["id", "updatedAt"])) return false;
    if (typeof item.id !== "string" || typeof item.updatedAt !== "string") return false;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
  }
  return true;
}
function hasPreferenceShape(key: string, value: unknown): boolean {
  if (key === "abot-web.pinnedSessions") return isStringList(value);
  if (key === "abot.spark.launcher.position.v1") return isLauncherPosition(value);
  if (key.startsWith("abot-web.homeGuidance.")) return isGuidancePreference(value);
  if (!isPreferenceObject(value)) return false;
  if (key === "abot-web.sessionModes") return Object.values(value).every(isSessionMode);
  if (key === "abot-web.sessionSidebarByEnvironment") return Object.values(value).every(isSidebarPreference);
  return Object.values(value).every((item) => typeof item === "string");
}
export function assertPreferenceShape(key: string, value: unknown): void {
  if (!hasPreferenceShape(key, value))
    throw new ClientStateError("invalid_preferences", "Invalid workspace preferences or unbounded memory review receipts.");
}
