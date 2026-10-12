import { createCollectionConsentDialog } from "./collection-consent-dialog.js";
import { hasCollectionAccess, needsCollectionConsentReview } from "./collection-access.js";
import { readActivityPermissions } from "./activity-controls.js";

function requestsCollectionAccess(preferences, snapshot) {
  if (preferences.enabled === false || preferences.activityPermissions?.collection === false) return false;
  if (preferences.enabled === true) return true;
  if (preferences.activityPermissions?.collection !== true) return false;
  return !readActivityPermissions(snapshot.status?.preferences).collection;
}

function collectionRequestContext(snapshot) {
  const host = snapshot.hostConnection;
  return JSON.stringify([
    snapshot.environmentId, host?.collectionSource, host?.hostId,
    host?.connected, host?.connectionId, snapshot.status?.preferences?.modelProfileId,
    snapshot.status?.preferences?.enabled,
  ]);
}

/** Installation consent precedes platform permission preparation and explicit activation. */
export function createCollectionConsentGate({
  actions, container, openComputerAccess = () => {}, createDialog = createCollectionConsentDialog,
}) {
  let dialog;
  let pending;
  let revision = 0;
  function cancel() {
    revision += 1;
    pending = undefined;
    dialog?.cancel();
  }
  function requestIsCurrent(request) {
    if (pending !== request) return false;
    return collectionRequestContext(actions.snapshot()) === request.context;
  }
  async function continueRequest(preferences, request) {
    try {
      if (actions.snapshot().hostConnection?.collectionConsent?.accepted !== true) {
        const freshHost = await actions.refreshCollectionAccess();
        if (!freshHost || !requestIsCurrent(request)) return;
      }
      if (actions.snapshot().hostConnection?.collectionConsent?.accepted !== true) {
        dialog ??= createDialog({ container });
        const approved = await dialog.confirm();
        if (!approved || !requestIsCurrent(request)) return;
        request.acknowledging = true;
        const host = await actions.acceptCollectionConsent();
        request.acknowledging = false;
        if (!requestIsCurrent(request)) return;
        if (host?.collectionConsent?.accepted !== true) return;
      }
      if (!requestIsCurrent(request)) return;
      const snapshot = actions.snapshot();
      if (preferences.enabled === true && !hasCollectionAccess(snapshot.hostConnection)) {
        pending = undefined;
        openComputerAccess();
        return;
      }
      pending = undefined;
      if (request.restart) return actions.restartCollection();
      const restartAfterConsent = preferences.enabled === true && needsCollectionConsentReview(snapshot.status);
      const status = await actions.configure(preferences);
      if (!restartAfterConsent || !status?.preferences?.enabled) return status;
      if (request.revision !== revision) return status;
      if (collectionRequestContext(actions.snapshot()) !== request.context) return status;
      return actions.restartCollection();
    } finally {
      if (pending === request) pending = undefined;
    }
  }
  function configure(preferences, restart = false) {
    const snapshot = actions.snapshot();
    if (!requestsCollectionAccess(preferences, snapshot)) {
      cancel();
      return actions.configure(preferences);
    }
    if (pending) return;
    if (snapshot.saving || snapshot.loadingStatus || !snapshot.status) return;
    const request = { context: collectionRequestContext(snapshot), acknowledging: false, restart, revision };
    pending = request;
    return continueRequest(preferences, request);
  }
  return {
    configure,
    restartCollection: () => configure({ enabled: true }, true),
    update(snapshot) {
      if (!pending) return;
      if (collectionRequestContext(snapshot) !== pending.context) return cancel();
      if (snapshot.saving && !pending.acknowledging) cancel();
    },
    cancel,
  };
}
