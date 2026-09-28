/** Increment when installed companions should be offered an update. Independent of the wire protocol. */
export const COMPANION_RELEASE_VERSION = 6;

export function companionReleaseStatus(version: unknown) {
  const installedVersion =
    typeof version === "number" && Number.isSafeInteger(version) && version > 0
      ? version
      : null;
  return {
    installedVersion,
    availableVersion: COMPANION_RELEASE_VERSION,
    updateAvailable:
      installedVersion === null || installedVersion < COMPANION_RELEASE_VERSION,
  };
}
