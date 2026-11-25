import { escapeHtml } from "../../lib/text-format.js";
import { dashboardIcon } from "../dashboard/icons.js";

const statusIcons = { success: "success", attention: "failed", failed: "failed", active: "active", neutral: "unknown" };

/** A stable, whole-card dialog trigger. Service owners supply observed status. */
export function createConnectionCard({ documentRoot, id, label, icon }) {
  const button = documentRoot.createElement("button");
  button.type = "button";
  button.className = "home-connection-card";
  button.setAttribute("data-home-connection", id);
  button.setAttribute("aria-haspopup", "dialog");
  button.innerHTML = `<span class="home-connection-heading"><span class="home-connection-icon">${dashboardIcon(icon)}</span>${dashboardIcon("arrow")}</span>
    <span class="home-connection-copy"><span class="home-connection-title">${escapeHtml(label)}</span><span class="home-connection-detail" data-connection-detail></span></span>
    <span class="home-connection-footer"><span class="home-connection-status" data-connection-status role="status" aria-live="polite" aria-atomic="true"></span><span class="home-connection-action" data-connection-action></span></span>`;
  const detailNode = button.querySelector("[data-connection-detail]");
  const statusNode = button.querySelector("[data-connection-status]");
  const actionNode = button.querySelector("[data-connection-action]");
  function render({ detail = "", status = "Checking", tone = "neutral", actionLabel = "Manage", disabled = false } = {}) {
    const statusTone = Object.hasOwn(statusIcons, tone) ? tone : "neutral";
    detailNode.textContent = detail;
    statusNode.dataset.tone = statusTone;
    const markup = `${dashboardIcon(statusIcons[statusTone])}<span>${escapeHtml(status)}</span>`;
    if (statusNode.innerHTML !== markup) statusNode.innerHTML = markup;
    actionNode.textContent = actionLabel;
    button.disabled = disabled;
    button.setAttribute("aria-label", [label, status, detail, actionLabel].filter(Boolean).join(". "));
  }
  render();
  return { button, render };
}
