import { basketStatusGroup } from "../../lib/information-basket-presentation.js";
import { basketIcon } from "./icons.js";

const STATUS_FILTERS = [
  ["all", "All sources"], ["ready", "Ready"],
  ["indexing", "Indexing"], ["attention", "Needs attention"],
];

/** Search and status projections share the workspace controller's existing state. */
export function createBasketLibraryControls({ root, actions }) {
  root.innerHTML = `<div class="basket-status-filters" role="group" aria-label="Filter by indexing status">${STATUS_FILTERS.map(([value, label]) =>
    `<button type="button" class="basket-filter basket-filter-${value}" data-basket-filter="${value}" aria-pressed="false"><span>${label}</span><span class="basket-filter-count" data-basket-filter-count="${value}">0</span></button>`).join("")}</div>
    <label class="basket-search">${basketIcon("search")}<input type="search" data-basket-search aria-label="Search sources" placeholder="Search sources…"></label>`;
  const search = root.querySelector("[data-basket-search]");
  const buttons = Array.from(root.querySelectorAll("[data-basket-filter]"));
  search.addEventListener("input", (event) => actions.setQuery(event.target.value));
  for (const button of buttons) {
    button.addEventListener("click", () => actions.setFilter(button.dataset.basketFilter));
  }
  function render(snapshot) {
    const counts = { all: snapshot.sources.length, ready: 0, indexing: 0, attention: 0 };
    for (const source of snapshot.sources) counts[basketStatusGroup(source)] += 1;
    for (const button of buttons) {
      const value = button.dataset.basketFilter;
      button.setAttribute("aria-pressed", String(value === (snapshot.filter || "all")));
      button.querySelector("[data-basket-filter-count]").textContent = String(counts[value]);
    }
    const query = snapshot.query || "";
    if (search.value !== query) search.value = query;
  }
  return { render };
}
