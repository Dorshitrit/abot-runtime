import { macCompanionPermissionPath } from "../system-host/macos-permissions.js";
import { createMacPermissionDialog } from "../system-host/macos-permission-dialog.js";

function requiresMacCollectionConsent(preferences, snapshot) {
  if (preferences.enabled !== true) return false;
  if (snapshot.status?.preferences?.enabled !== false) return false;
  return Boolean(macCompanionPermissionPath(snapshot.hostConnection));
}

function collectionConsentContext(snapshot) {
  const host = snapshot.hostConnection;
  return JSON.stringify([
    snapshot.environmentId,
    host?.hostId,
    host?.connected,
    host?.connectionId,
    host?.identity?.os,
    host?.identity?.homeDir,
    host?.companion?.installedVersion,
  ]);
}

function canContinueCollectionStart(snapshot, context) {
  if (snapshot.saving) return false;
  if (snapshot.status?.preferences?.enabled !== false) return false;
  if (!macCompanionPermissionPath(snapshot.hostConnection)) return false;
  return collectionConsentContext(snapshot) === context;
}

/** Covers explicit collection starts from Home, Spark controls and Settings. */
export function createMacCollectionConsent({
  actions,
  container,
  createDialog = createMacPermissionDialog,
}) {
  let dialog;
  let pending;

  function cancel() {
    pending = undefined;
    dialog?.cancel();
  }
  async function confirmStart(preferences, request, path) {
    try {
      dialog ??= createDialog({ container });
      const approved = await dialog.confirm(path);
      if (pending !== request) return;
      if (!approved) return;
      if (!canContinueCollectionStart(actions.snapshot(), request.context))
        return;
      pending = undefined;
      return actions.configure(preferences);
    } finally {
      if (pending === request) pending = undefined;
    }
  }
  return {
    configure(preferences) {
      if (pending) return;
      const snapshot = actions.snapshot();
      if (!requiresMacCollectionConsent(preferences, snapshot))
        return actions.configure(preferences);
      if (snapshot.saving) return;
      const request = { context: collectionConsentContext(snapshot) };
      pending = request;
      return confirmStart(
        preferences,
        request,
        macCompanionPermissionPath(snapshot.hostConnection),
      );
    },
    update(snapshot) {
      if (!pending) return;
      if (!canContinueCollectionStart(snapshot, pending.context)) cancel();
    },
    cancel,
  };
}
