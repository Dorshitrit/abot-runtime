export const NAVIGATION_PREFERENCE_KEY = "abot-web.navigationDisplay";
export const DEFAULT_NAVIGATION_MODE = "labels";

export function isNavigationMode(value) {
  return value === "labels" || value === "icons";
}

export function savedNavigationMode(storage) {
  const acknowledged = storage.snapshot?.();
  const value = acknowledged ? acknowledged.preferences[NAVIGATION_PREFERENCE_KEY] : storage.getItem(NAVIGATION_PREFERENCE_KEY);
  return isNavigationMode(value) ? value : DEFAULT_NAVIGATION_MODE;
}
