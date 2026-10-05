const pages = Object.freeze({
  models: { category: "models", title: "Models" },
  plugins: { category: "plugins", title: "Plugins" },
  config: { category: "operations", title: "System" },
});

export function isConfigurationWorkspace(workspace) {
  return Object.hasOwn(pages, workspace);
}

export function configurationCategoryForWorkspace(workspace) {
  return pages[workspace]?.category;
}

export function legacyConfigurationWorkspace(category) {
  if (category === "computer") return "home";
  if (category === "memory") return "memory";
  if (category === "plugins") return "plugins";
  if (category === "operations") return "config";
  return "models";
}

/** One editing owner is presented as three independently addressed pages. */
export function renderConfigurationPageHeading(panel, workspace) {
  const page = pages[workspace];
  if (!panel || !page) return;
  const title = panel.querySelector("#configWorkspaceTitle");
  if (title) title.textContent = page.title;
}
