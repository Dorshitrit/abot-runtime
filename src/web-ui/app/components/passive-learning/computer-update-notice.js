import { isNativeWindowsLocalAccess } from "../system-host/native-windows-access.js";

export function computerUpdateNoticeMarkup() {
  return `<div class="co-worker-computer-update" data-learning-update hidden role="status">
    <span class="co-worker-computer-update-icon" aria-hidden="true">↑</span>
    <div class="co-worker-computer-update-copy"><p class="co-worker-computer-update-title">Computer access update required</p>
      <p data-learning-update-text>Check Computer access for compatible Companion update options.</p></div>
    <button type="button" data-learning-open-update>Update Computer access <span aria-hidden="true">↗</span></button>
  </div>`;
}

function needsCompanionUpdate(connection) {
  if (connection?.companion?.updateAvailable) return true;
  if (connection?.connected !== true) return false;
  return connection.readiness?.companionUpdateRequired === true;
}

export function renderComputerUpdateNotice(root, snapshot) {
  if (isNativeWindowsLocalAccess(snapshot.hostConnection)) {
    root.querySelector("[data-learning-update]").hidden = true;
    return;
  }
  root.querySelector("[data-learning-update]").hidden =
    !needsCompanionUpdate(snapshot.hostConnection);
}
