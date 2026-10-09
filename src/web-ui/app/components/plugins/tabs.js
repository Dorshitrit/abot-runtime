import { renderPluginDiscovery } from "./discovery-rendering.js";
const names = ["installed", "discover"];

export function renderPluginTabs(installed, discovery, active = "installed") {
  const button = (name, label) =>
    `<button type="button" id="plugin-${name}-tab" class="config-category-tab${active === name ? " active" : ""}" role="tab" data-plugin-tab="${name}" aria-controls="plugin-${name}-panel" aria-selected="${active === name}" tabindex="${active === name ? 0 : -1}">${label}</button>`;
  return `<div class="plugin-workspace"><nav class="config-category-nav" role="tablist" aria-label="Plugin views">${button("installed", "Installed")}${button("discover", "Discover")}</nav>
    <div id="plugin-installed-panel" class="config-category-panel" role="tabpanel" aria-labelledby="plugin-installed-tab" tabindex="0"${active === "installed" ? "" : " hidden"}>${installed}</div>
    <div id="plugin-discover-panel" class="config-category-panel" role="tabpanel" aria-labelledby="plugin-discover-tab" tabindex="0"${active === "discover" ? "" : " hidden"}>${renderPluginDiscovery(discovery)}</div></div>`;
}

export function bindPluginTabs(root, activate) {
  for (const button of root.querySelectorAll("[data-plugin-tab]")) {
    button.addEventListener("click", () =>
      activate(button.dataset.pluginTab, true),
    );
    button.addEventListener("keydown", (event) => {
      const index = names.indexOf(button.dataset.pluginTab);
      let target;
      if (event.key === "ArrowRight")
        target = names[(index + 1) % names.length];
      if (event.key === "ArrowLeft")
        target = names[(index + names.length - 1) % names.length];
      if (event.key === "Home") target = names[0];
      if (event.key === "End") target = names.at(-1);
      if (!target) return;
      event.preventDefault();
      activate(target, true);
    });
  }
}
