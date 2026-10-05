import { escapeHtml } from "../../lib/text-format.js";
import { renderAutomationTemplateGallery } from "./template-gallery.js";

const tabs = ["studio", "templates"];

export function automationLibraryTabForKey(key, index) {
  if (key === "Home") return tabs[0];
  if (key === "End") return tabs.at(-1);
  if (key === "ArrowRight") return tabs[(index + 1) % tabs.length];
  if (key === "ArrowLeft") return tabs[(index + tabs.length - 1) % tabs.length];
  return "";
}

export function renderAutomationLibraryTabs(snapshot, studioMarkup, activeTab = "studio") {
  const selected = tabs.includes(activeTab) ? activeTab : "studio";
  const tabButton = (name, label) => `<button id="automation-${name}-tab" class="config-category-tab${selected === name ? " active" : ""}" type="button" role="tab" data-automation-library-tab="${name}" aria-controls="automation-${name}-panel" aria-selected="${selected === name}" tabindex="${selected === name ? 0 : -1}">${label}</button>`;
  return `<div class="config-dashboard automation-workspace-content">
    <nav class="config-category-nav automation-workspace-nav" role="tablist" aria-label="ABot Studio views">
      ${tabButton("studio", "Studio")}${tabButton("templates", "Templates")}
    </nav>
    <div class="config-category-panels">
      <div id="automation-studio-panel" class="config-category-panel" role="tabpanel" aria-labelledby="automation-studio-tab" tabindex="0" data-automation-library-panel="studio"${selected === "studio" ? "" : " hidden"}>${studioMarkup}</div>
      <div id="automation-templates-panel" class="config-category-panel" role="tabpanel" aria-labelledby="automation-templates-tab" tabindex="0" data-automation-library-panel="templates"${selected === "templates" ? "" : " hidden"}>
        ${snapshot.error ? `<p class="automation-feedback" data-tone="error" role="status">${escapeHtml(snapshot.error)}</p>` : ""}
        ${renderAutomationTemplateGallery(snapshot)}
      </div>
    </div>
  </div>`;
}

export function activateAutomationLibraryTab(root, name, { focus = false } = {}) {
  if (!tabs.includes(name)) return false;
  for (const tabName of tabs) {
    const button = root.querySelector(`[data-automation-library-tab="${tabName}"]`);
    const panel = root.querySelector(`[data-automation-library-panel="${tabName}"]`);
    if (!button || !panel) return false;
    const active = tabName === name;
    button.setAttribute("aria-selected", String(active));
    button.setAttribute("tabindex", active ? "0" : "-1");
    button.className = `config-category-tab${active ? " active" : ""}`;
    panel.hidden = !active;
    if (focus && active) button.focus();
  }
  return true;
}
