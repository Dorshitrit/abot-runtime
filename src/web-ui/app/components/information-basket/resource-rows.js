import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";
import { basketIndexedTime, basketSize, basketStatusGroup, basketStatusLabel, isBasketSourceWorking } from "../../lib/information-basket-presentation.js";
import { basketIcon } from "./icons.js";

export function renderBasketSourceRows(snapshot) {
  return snapshot.visibleSources.map((source) => {
    const id = escapeAttribute(source.sourceId);
    const pending = source.status === "pending_path";
    const disabled = snapshot.mutation ? "disabled" : "";
    const reindexDisabled = snapshot.mutation || isBasketSourceWorking(source) ? "disabled" : "";
    const action = pending
      ? `<button type="button" class="basket-text-button" data-basket-link="${id}" ${disabled}>Link path</button>`
      : `<button type="button" class="basket-text-button" data-basket-reindex="${id}" ${reindexDisabled}>Re-index</button>`;
    return `<tr><td class="basket-check-cell"><input type="checkbox" data-basket-select="${id}" aria-label="Select ${escapeAttribute(source.displayName)}" ${disabled}></td>
      <td><div class="basket-source-cell"><span class="basket-file-icon">${basketIcon("file")}</span><div><button type="button" class="basket-source-name" data-basket-detail="${id}" dir="auto">${escapeHtml(source.displayName)}</button><span class="basket-source-path" dir="ltr">${escapeHtml(source.path || "Choose the original file path")}</span></div></div></td>
      <td><span class="basket-status basket-status-${basketStatusGroup(source)}"><span aria-hidden="true"></span>${basketStatusLabel(source.status)}</span></td>
      <td class="basket-time-cell">${escapeHtml(basketIndexedTime(source.indexedAt))}</td>
      <td class="basket-row-actions">${action}<button type="button" class="basket-text-button basket-remove" data-basket-remove="${id}" aria-label="Remove ${escapeAttribute(source.displayName)} from basket" ${disabled}>Remove</button></td></tr>`;
  }).join("");
}

export function renderBasketSourceDetails(source) {
  if (!source) return "";
  const pending = source.status === "pending_path";
  return `<div class="basket-detail-heading"><h3 dir="auto">${escapeHtml(source.displayName)}</h3><button type="button" class="basket-text-button" data-basket-detail="">Close details</button></div>
    <dl class="basket-detail-grid"><div><dt>Source path</dt><dd dir="ltr">${escapeHtml(source.path || "Not linked")}</dd></div><div><dt>Status</dt><dd>${basketStatusLabel(source.status)}</dd></div><div><dt>Size</dt><dd>${basketSize(source.sizeBytes)}</dd></div><div><dt>Indexed sections</dt><dd>${pending ? "—" : source.chunkCount}</dd></div><div><dt>Last indexed</dt><dd>${escapeHtml(basketIndexedTime(source.indexedAt))}</dd></div></dl>
    ${source.reason ? `<p class="basket-source-reason" role="status">${escapeHtml(source.reason)}</p>` : ""}
    <p class="basket-note">${pending ? "Your browser supplies the filename. Select its original path to make the source available." : "The original file stays at this path. Removing this resource only removes it from your basket."}</p>`;
}
