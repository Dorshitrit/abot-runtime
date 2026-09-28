const permissionReasons = new Set([
  "macos_accessibility_permission_required",
  "macos_accessibility_permission_timeout",
  "macos_accessibility_permission_revoked",
]);

function hasEnabledMacCollection(snapshot) {
  if (snapshot.hostConnection?.identity?.os !== "macos") return false;
  return snapshot.status?.preferences?.enabled === true;
}

export function hasMacCollectionPermissionBlock(snapshot) {
  if (!hasEnabledMacCollection(snapshot)) return false;
  if (snapshot.status.collectionState !== "permission_required") return false;
  return permissionReasons.has(snapshot.status.collectionReason);
}

function canRestartMacCollection(snapshot, actions) {
  if (!hasMacCollectionPermissionBlock(snapshot)) return false;
  if (snapshot.saving || snapshot.loadingStatus) return false;
  if (snapshot.restartingCollection) return false;
  return typeof actions.restartCollection === "function";
}

export function macCollectionRestartNoticeMarkup() {
  return `<div class="co-worker-computer-update" data-learning-mac-restart hidden role="status">
    <span class="co-worker-computer-update-icon" aria-hidden="true">↻</span>
    <div class="co-worker-computer-update-copy"><p class="co-worker-computer-update-title">Spark needs Accessibility access</p>
      <p>Already granted access? Restart collection to check again.</p></div>
    <button type="button" data-learning-restart-collection>Restart collection</button>
  </div>`;
}

export function renderMacCollectionRestartNotice(root, snapshot) {
  const notice = root.querySelector("[data-learning-mac-restart]");
  const blocked = hasMacCollectionPermissionBlock(snapshot);
  const restartingMacCollection = hasEnabledMacCollection(snapshot) && snapshot.restartingCollection;
  notice.hidden = !blocked && !restartingMacCollection;
  notice.setAttribute("aria-busy", String(Boolean(snapshot.restartingCollection)));
  const button = notice.querySelector("[data-learning-restart-collection]");
  button.disabled = Boolean(snapshot.saving || snapshot.loadingStatus || snapshot.restartingCollection || !blocked);
  button.textContent = snapshot.restartingCollection ? "Restarting collection…" : "Restart collection";
}

export function handleMacCollectionRestartClick(root, event, actions) {
  const button = event.target.closest("[data-learning-restart-collection]");
  if (!button || !root.contains(button)) return false;
  if (button.disabled) return true;
  if (!canRestartMacCollection(actions.snapshot(), actions)) return true;
  void actions.restartCollection();
  return true;
}
