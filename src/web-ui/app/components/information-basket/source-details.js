import { renderBasketSourceDetails } from "./resource-rows.js";

export function createBasketSourceDetails({ root, close, documentRoot = document }) {
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "basket-detail basket-detail-dialog";
  dialog.setAttribute("aria-label", "Source details");
  root.append(dialog);
  let markup = "";
  let returnFocus;
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation(); close();
  });
  return { render(source) {
    if (!source) {
      if (dialog.open) dialog.close();
      if (returnFocus?.isConnected && !returnFocus.closest("[hidden], [inert]")) returnFocus.focus();
      returnFocus = null;
      return;
    }
    const nextMarkup = renderBasketSourceDetails(source);
    if (markup !== nextMarkup) { dialog.innerHTML = nextMarkup; markup = nextMarkup; }
    if (!dialog.open) { returnFocus = documentRoot.activeElement; dialog.showModal(); }
  } };
}
