/** Uses the shared server count, including issues outside the loaded inbox page. */
export function createHomeErrorAttention({ homePanel, onOpen }) {
  const header = homePanel?.querySelector(".home-workspace-header");
  if (!header) return { render() {} };
  const region = homePanel.ownerDocument.createElement("div");
  region.className = "home-error-attention";
  region.hidden = true;
  region.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17h.01"/></svg>
    <span class="home-error-attention-label" role="status" aria-live="polite"></span>
    <button type="button" aria-controls="notificationsWorkspacePanel">Open notifications <span aria-hidden="true">→</span></button>`;
  const label = region.querySelector(".home-error-attention-label");
  region.querySelector("button").addEventListener("click", () => {
    if (!region.hidden) onOpen();
  });
  header.after(region);
  let previous = "";
  return {
    render(snapshot) {
      const count = snapshot.unreadErrorCount;
      const visible = snapshot.supported && Number.isSafeInteger(count) && count > 0;
      region.hidden = !visible;
      const description = visible ? `${count} unread ${count === 1 ? "error needs" : "errors need"} your attention` : "";
      if (description === previous) return;
      previous = description;
      label.textContent = description;
    },
  };
}
