import { hostSetupIsReady } from "../system-host/rendering.js";
import { isNativeWindowsLocalAccess } from "../system-host/native-windows-access.js";

export function hasCollectionAccess(hostConnection) {
  if (isNativeWindowsLocalAccess(hostConnection)) return true;
  return hostSetupIsReady(hostConnection);
}

export function needsCollectionConsentReview(status) {
  if (status?.preferences?.enabled !== true) return false;
  const reason = status.collectionReason || status.reason;
  return reason === "collection_consent_required";
}

function collectionCompanionVersion(host) {
  if (isNativeWindowsLocalAccess(host)) return "";
  const companion = host?.companion;
  if (!companion) return "Connect your computer to check its companion version.";
  return `Installed version: ${companion.installedVersion ?? "unversioned"} · Available: ${companion.availableVersion}`;
}

/** Display the actual collection source without treating Companion identity as Runtime identity. */
export function renderCollectionAccess(root, snapshot) {
  const native = isNativeWindowsLocalAccess(snapshot.hostConnection);
  const version = root.querySelector("[data-learning-companion-version]");
  version.hidden = native;
  version.textContent = collectionCompanionVersion(snapshot.hostConnection);
  root.querySelector("[data-learning-computer-access]").hidden = native;
  root.querySelector("[data-learning-connection-title]").textContent = native ? "Local collection" : "Computer connection";
  root.querySelector("[data-learning-connection-description]").textContent = native
    ? "Spark collects activity directly on this Windows computer after your consent. Collection and learning have separate permission and Start controls."
    : "Collection uses the shared Computer access connection. Computer tools have their own controls.";
  root.querySelector("[data-learning-device]").textContent = native
    ? "This Windows computer" : snapshot.status?.deviceId || "Not connected now";
}
