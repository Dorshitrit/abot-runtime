const pages = Object.freeze({
  models: { category: "models", title: "Models", description: "Choose and configure the models available to your agents." },
  plugins: { category: "plugins", title: "Plugins", description: "Manage the capabilities available to your agents." },
  config: { category: "operations", title: "System", description: "Inspect runtime status, logs and health, and apply saved settings." },
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
  const description = panel.querySelector("#configWorkspaceDescription");
  if (title) title.textContent = page.title;
  if (description) description.textContent = page.description;
}
