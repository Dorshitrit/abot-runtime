import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

const renderedSummaries = new WeakMap();

function renderSummaryItems(summary) {
  return summary.items.map(({ label, value, status, dirty }) => `
    <div class="config-summary-item">
      <dt>${escapeHtml(label)}</dt>
      <dd class="config-summary-value${dirty ? " dirty" : ""}"
        title="${escapeAttribute(value)}"
        ${status ? 'data-config-summary-status role="status" aria-live="polite"' : ""}
      >${escapeHtml(value)}</dd>
    </div>
  `).join("");
}

export function renderConfigurationSummary(summary) {
  return `<dl class="config-summary" data-config-summary aria-label="${escapeAttribute(summary.label)}">${renderSummaryItems(summary)}</dl>`;
}

export function syncConfigurationSummary(root, summary) {
  const element = root.querySelector("[data-config-summary]");
  if (!element) return;
  const content = renderSummaryItems(summary);
  const previous = renderedSummaries.get(element);
  if (previous?.content === content && previous.label === summary.label) return;
  element.setAttribute("aria-label", summary.label);
  element.innerHTML = content;
  renderedSummaries.set(element, { content, label: summary.label });
}
