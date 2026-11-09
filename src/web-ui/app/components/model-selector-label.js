const executionRoutes = new Map([
  ["supervisor-worker-v1", { label: "Super", name: "Supervisor" }],
  ["execution-agent-v1", { label: "EA", name: "Execution Agent" }],
]);

/** Project catalog metadata without inferring a route from the model name. */
export function renderSelectedModelLabel({
  valueLabel, button, documentRoot, provider, model, executionPolicy,
}) {
  const route = executionRoutes.get(executionPolicy);
  const identity = provider ? `${provider} / ${model}` : model;
  const description = route ? `; Next request route: ${route.name}` : "";
  button.title = `Model: ${identity}${description}`;
  button.setAttribute("aria-label", button.title);
  valueLabel.classList.add("model-select-value");
  valueLabel.replaceChildren();
  if (provider) {
    const label = documentRoot.createElement("span");
    label.className = "model-select-provider";
    label.textContent = provider;
    const separator = documentRoot.createElement("span");
    separator.className = "model-select-separator";
    separator.textContent = " / ";
    valueLabel.append(label, separator);
  }
  const label = documentRoot.createElement("span");
  label.className = "model-select-name";
  label.textContent = model;
  valueLabel.append(label);
  if (!route) return;
  const indicator = documentRoot.createElement("span");
  indicator.className = "model-select-route";
  indicator.textContent = route.label;
  indicator.title = `Next request route: ${route.name}`;
  valueLabel.append(indicator);
}
