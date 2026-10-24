export const NAVIGATION_PREFERENCE_KEY: "abot-web.navigationDisplay";
export const DEFAULT_NAVIGATION_MODE: "labels";
export type NavigationMode = "labels" | "icons";
export function isNavigationMode(value: unknown): value is NavigationMode;
export function savedNavigationMode(storage: {
  getItem(key: string): string | null;
  snapshot?(): { preferences: Record<string, string> } | null;
}): NavigationMode;
