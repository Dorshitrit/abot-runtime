/** A quiet, explicit way back to the existing saved-memory review. */
export function createDailyReviewEntry({ container, onOpen }) {
  const root = container.ownerDocument.createElement("aside");
  root.className = "home-guidance home-memory-review";
  root.hidden = true;
  root.setAttribute("aria-label", "Saved memory review");
  root.innerHTML = `<div class="home-guidance-copy"><h3 class="home-row-title">Saved memories</h3>
    <p class="home-row-detail"></p></div>
    <button type="button" class="home-text-button" data-review-open>Review memories</button>`;
  container.prepend(root);
  const button = root.querySelector("[data-review-open]");
  button.addEventListener("click", () => void onOpen());
  return {
    render({ visible, remaining, loading }) {
      root.hidden = !visible;
      root.querySelector("p").textContent = remaining > 0
        ? `${remaining} saved ${remaining === 1 ? "memory" : "memories"} to review. Come back whenever you're ready.`
        : "Review what ABot Spark has saved. Keep what fits or delete what doesn't.";
      button.disabled = loading;
      button.textContent = loading ? "Loading…" : "Review memories";
    },
    dispose() { root.remove(); },
  };
}
