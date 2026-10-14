import { escapeHtml } from "../../lib/text-format.js";
import { dashboardIcon } from "./icons.js";

const compactLabels = { conversations: "Conversations", approvals: "Approvals" };

function symbolMarkup(indicator) {
  if (!indicator) return "";
  const label = escapeHtml(indicator.label || "");
  const value = indicator.value === undefined ? "" : `<span aria-hidden="true">${escapeHtml(String(indicator.value))}</span>`;
  const glyph = indicator.icon ? dashboardIcon(indicator.icon) : "";
  return `<span class="home-widget-symbol" data-tone="${escapeHtml(indicator.tone || "neutral")}" role="img" aria-label="${label}" title="${label}">${glyph}${value}</span>`;
}

function copyMarkup(title, detail = "") {
  return `<span class="home-widget-copy"><span class="home-widget-item-title" dir="auto" title="${escapeHtml(title)}">${escapeHtml(title)}</span><span class="home-widget-meta" dir="auto" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span></span>`;
}

function rowsMarkup(preview) {
  return preview.items.map((item) => `<span class="home-widget-row">${copyMarkup(item.title, item.detail)}${symbolMarkup(item.indicator)}</span>`).join("");
}

function metricsMarkup(preview) {
  return `<span class="home-widget-metrics">${preview.items.map((item) => `<span class="home-widget-metric">${symbolMarkup(item.indicator)}<span>${escapeHtml(item.label)}</span></span>`).join("")}</span>`;
}

function computerMarkup(preview) {
  const checks = preview.items.map((item) => `<span class="home-widget-check"><span>${escapeHtml(item.label)}</span>${symbolMarkup(item.indicator)}</span>`).join("");
  return `<span class="home-widget-computer"><span class="home-widget-device"><span class="home-widget-item-title" dir="auto">${escapeHtml(preview.title)}</span><span class="home-widget-meta">${escapeHtml(preview.detail || "")}</span></span><span class="home-widget-checks">${checks}</span></span>`;
}

function previewMarkup(summary) {
  const preview = summary.preview;
  if (preview?.kind === "rows") return rowsMarkup(preview);
  if (preview?.kind === "metrics") return metricsMarkup(preview);
  if (preview?.kind === "computer") return computerMarkup(preview);
  if (preview?.kind === "automation")
    return `<span class="home-widget-automation">${symbolMarkup(preview.indicator)}${copyMarkup(preview.title, preview.detail)}</span>`;
  return `<span class="home-widget-fallback"><span class="home-widget-title" dir="auto">${escapeHtml(summary.title || "")}</span><span class="home-widget-detail" dir="auto">${escapeHtml(summary.detail || "")}</span><span class="home-widget-status" dir="auto">${escapeHtml(summary.status || "")}</span></span>`;
}

function previewDescriptions(summary) {
  const preview = summary.preview;
  if (!preview) return [];
  const descriptions = [preview.title, preview.detail];
  descriptions.push(...(preview.items || []).map((item) =>
    [item.title, item.label, item.detail, item.indicator?.label].filter(Boolean).join(": "),
  ));
  if (preview.indicator) descriptions.push(preview.indicator.label);
  return descriptions.filter(Boolean);
}

/** A stable button; only the read-only preview changes, never the live component. */
export function createHomeWidgetCard({ documentRoot, id, label, icon }) {
  const button = documentRoot.createElement("button");
  button.type = "button";
  button.className = "home-widget";
  button.dataset.homeWidget = id;
  button.setAttribute("aria-haspopup", "dialog");
  const glyph = id === "learning" ? '<img src="/spark-mascot.svg" alt="" />' : dashboardIcon(icon);
  button.innerHTML = `<span class="home-widget-heading"><span class="home-widget-heading-icon">${glyph}</span><span data-widget-label></span><span class="home-widget-badge" hidden></span><span class="home-widget-arrow" aria-hidden="true">›</span></span><span class="home-widget-preview"></span>`;
  button.querySelector("[data-widget-label]").textContent = compactLabels[id] || label;
  const body = button.querySelector(".home-widget-preview");
  const badge = button.querySelector(".home-widget-badge");
  let previousMarkup;
  let previousBadge;
  function render(summary) {
    const markup = previewMarkup(summary);
    if (markup !== previousMarkup) {
      body.innerHTML = markup;
      previousMarkup = markup;
    }
    const badgeMarkup = symbolMarkup(summary.preview?.badge);
    if (badgeMarkup !== previousBadge) {
      badge.innerHTML = badgeMarkup;
      previousBadge = badgeMarkup;
    }
    badge.hidden = !badgeMarkup;
    button.dataset.tone = summary.tone || "neutral";
    button.setAttribute("aria-label", `${label} — open details`);
    const description = [...new Set([summary.title, summary.detail, summary.status, ...previewDescriptions(summary)].filter(Boolean))].join(". ");
    button.setAttribute("aria-description", description);
    button.setAttribute("title", description);
  }
  return { button, render };
}
