import { renderConnectionCard } from "./connection-card.js";

/** The server's native Windows facts identify local access, independently of tool readiness. */
export function isNativeWindowsLocalAccess(snapshot) {
  if (snapshot?.collectionSource?.mode !== "native") return false;
  return snapshot.collectionSource.platform === "windows";
}

export function shouldRenderNativeWindowsAccess(input) {
  if (!input.supported) return false;
  return isNativeWindowsLocalAccess(input.snapshot);
}

function nativeWindowsAccessPresentation(input) {
  if (input.statusUnavailable) return {
    title: "Check Windows access", status: "Status unavailable",
    description: "The current local access status could not be checked. Refresh to try again.",
  };
  if (input.busy) return {
    title: "Checking Windows access…", status: "Checking",
    description: "Waiting for the current local access status…",
  };
  if (input.snapshot?.readiness?.directAccessReady === false) return {
    title: "Check local Windows access", status: "Check needed",
    description: "ABot runs directly on Windows, but direct commands could not be verified. Refresh to check again. Companion pairing is not required for local tools.",
  };
  return {
    title: "Windows access is local", status: "Local",
    description: "ABot runs directly on this Windows computer. Local tools do not need Companion pairing. Compatible plugins and your permission settings determine which actions are available.",
  };
}

function canCompactNativeWindowsAccess(input) {
  if (!input.compact) return false;
  if (input.statusUnavailable || input.busy) return false;
  if (input.error || input.message) return false;
  return input.snapshot?.readiness?.directAccessReady !== false;
}

export function renderNativeWindowsAccess(input) {
  const presentation = nativeWindowsAccessPresentation(input);
  const compact = canCompactNativeWindowsAccess(input);
  return renderConnectionCard({
    ...presentation, ready: false, compact, disabled: input.busy,
    actions: '<button type="button" class="system-host-card-secondary" data-system-host-refresh' +
      (input.busy ? " disabled" : "") + '>Refresh status</button>',
    error: input.error, message: input.message,
    attributes: "data-system-host-native-windows",
  });
}
