import type { PassiveObservationSource } from "./passive-observation.js";

// Include the previous title so tabs opened before an update are also excluded.
const OWN_WEB_UI_TITLES = ["ABot Runtime — Workspace", "ABot Runtime"];
const BROWSER_WINDOW_NAMES = [
  "Mozilla Firefox",
  "Mozilla Firefox (Private Browsing)",
  "Google Chrome",
  "Chromium",
  "Microsoft Edge",
  "Brave",
  "Safari",
] as const;
const BROWSER_WINDOW_SUFFIXES = BROWSER_WINDOW_NAMES.flatMap((browser) => [
  ` — ${browser}`,
  ` - ${browser}`,
]);

function isOwnWebUiWindowTitle(title: string | undefined): boolean {
  if (typeof title !== "string") return false;
  if (OWN_WEB_UI_TITLES.includes(title)) return true;
  const suffix = BROWSER_WINDOW_SUFFIXES.find((candidate) =>
    title.endsWith(candidate),
  );
  if (!suffix) return false;
  return OWN_WEB_UI_TITLES.includes(title.slice(0, -suffix.length));
}

/** Application-wide exclusions have no user-configurable collection control. */
export function isOwnObservationApplication(app: string): boolean {
  // The Windows collector emits ProcessName (ABot), without .exe or an install path.
  // QA and packaged installations retain this identity while using ABot.exe.
  return app.toLowerCase() === "abot";
}

/** Mandatory self-exclusion is independent of the user's application rules. */
export function isOwnApplicationObservation(source: PassiveObservationSource): boolean {
  if (isOwnObservationApplication(source.app)) return true;
  return isOwnWebUiWindowTitle(source.title);
}
