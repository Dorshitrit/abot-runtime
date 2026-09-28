import { escapeHtml } from "../../lib/text-format.js";

export function createDailyReviewDialog({ container, onDecision, onDismiss }) {
  const documentRoot = container.ownerDocument;
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "daily-memory-review";
  dialog.setAttribute("aria-labelledby", "dailyMemoryTitle");
  dialog.setAttribute("aria-describedby", "dailyMemoryDescription");
  dialog.innerHTML = `<header><h2 id="dailyMemoryTitle">Review saved memories</h2>
    <button type="button" data-review-close aria-label="Close daily memory review">×</button></header>
    <p id="dailyMemoryDescription">Review memories saved by ABot Spark. Keep or delete each one.</p>
    <div class="daily-review-progress"><span data-review-count></span><progress data-review-progress aria-label="Memories reviewed"></progress></div>
    <article class="daily-review-card" data-review-card tabindex="0" aria-label="Memory review"></article>
    <p class="daily-review-error" role="alert" data-review-error hidden></p>
    <div class="daily-review-actions"><button type="button" data-review-delete>Delete memory</button>
      <button type="button" data-review-keep>Keep memory</button></div>
    <p class="daily-review-note">These memories are already saved. Keep marks them as reviewed in this browser.</p>
    <button type="button" class="daily-review-later" data-review-later>Not now</button>`;
  container.append(dialog);
  let returnFocus;
  const close = () => { dialog.close(); onDismiss(); };
  dialog.querySelector("[data-review-close]").addEventListener("click", close);
  dialog.querySelector("[data-review-later]").addEventListener("click", close);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => {
    if (returnFocus?.isConnected && !returnFocus.closest("[hidden]")) returnFocus.focus();
  });
  dialog.querySelector("[data-review-delete]").addEventListener("click", () => void onDecision("delete"));
  dialog.querySelector("[data-review-keep]").addEventListener("click", () => void onDecision("keep"));
  function render(snapshot) {
    const { items, index, busy, error } = snapshot;
    const record = items[index];
    const hasReviewLoadError = !record && Boolean(error);
    let completionText = items.length ? "Review complete." : "No memories to review.";
    if (hasReviewLoadError) completionText = "Review unavailable.";
    const contentKey = record ? `${record.id}:${record.updatedAt}` : completionText;
    const card = dialog.querySelector("[data-review-card]");
    if (card.dataset.record !== contentKey) {
      card.dataset.record = contentKey;
      card.innerHTML = record
        ? `<p dir="auto">${escapeHtml(record.content)}</p><span>Saved ${escapeHtml(new Date(record.createdAt).toLocaleDateString())}</span>`
        : `<p>${completionText}</p>`;
      card.scrollTop = 0;
    }
    const count = dialog.querySelector("[data-review-count]");
    count.textContent = record ? `${index + 1} of ${items.length}` : `${items.length} reviewed`;
    if (hasReviewLoadError) count.textContent = "";
    dialog.querySelector(".daily-review-progress").hidden = hasReviewLoadError;
    const progress = dialog.querySelector("progress");
    progress.max = Math.max(1, items.length);
    progress.value = hasReviewLoadError ? 0 : index;
    dialog.querySelector("[data-review-error]").textContent = error;
    dialog.querySelector("[data-review-error]").hidden = !error;
    dialog.querySelector(".daily-review-actions").hidden = !record;
    for (const button of dialog.querySelectorAll(".daily-review-actions button")) button.disabled = busy;
    dialog.querySelector("[data-review-delete]").textContent = busy ? "Deleting…" : "Delete memory";
    const later = dialog.querySelector("[data-review-later]");
    later.textContent = record ? "Not now" : "Done";
    if (hasReviewLoadError) later.textContent = "Close";
    dialog.querySelector(".daily-review-note").hidden = hasReviewLoadError;
    if (!record && dialog.open) dialog.querySelector("[data-review-later]").focus();
  }
  function canOpen() {
    if (dialog.open || documentRoot.hidden) return false;
    if (documentRoot.querySelector("dialog[open]")) return false;
    const focused = documentRoot.activeElement;
    return !focused?.matches("input, textarea, select, [contenteditable=true]");
  }
  return {
    render, canOpen,
    isOpen: () => dialog.open,
    open() {
      returnFocus = documentRoot.activeElement;
      dialog.showModal();
      dialog.querySelector("[data-review-later]").focus();
    },
    hide() { if (dialog.open) dialog.close(); },
    dispose() { dialog.close(); dialog.remove(); },
  };
}
