export function computerUpdateNoticeMarkup() {
  return `<div class="co-worker-computer-update" data-learning-update hidden role="status">
    <span class="co-worker-computer-update-icon" aria-hidden="true">↑</span>
    <div class="co-worker-computer-update-copy"><p class="co-worker-computer-update-title">Computer access update available</p>
      <p data-learning-update-text>Update this computer to get the latest fixes and collection protections.</p></div>
    <button type="button" data-learning-open-update>Update Computer access <span aria-hidden="true">↗</span></button>
  </div>`;
}

export function renderComputerUpdateNotice(root, snapshot) {
  root.querySelector("[data-learning-update]").hidden =
    !snapshot.hostConnection?.companion?.updateAvailable;
}
