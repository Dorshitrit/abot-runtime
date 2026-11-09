/** The provider/model drill-down is presentation only; selection belongs to the controller. */
export function renderModelSelectorMenu({
  menu, groups, providerId, selectedValue, documentRoot, onBrowse, onBack, onChoose,
}) {
  menu.replaceChildren();

  function action(className, role = "menuitem") {
    const item = documentRoot.createElement("button");
    item.type = "button";
    item.className = className;
    item.setAttribute("role", role);
    item.setAttribute("data-selector-item", "true");
    item.tabIndex = -1;
    return item;
  }

  function heading(text, className = "model-select-menu-title") {
    const title = documentRoot.createElement("div");
    title.className = className;
    title.setAttribute("aria-hidden", "true");
    title.textContent = text;
    menu.appendChild(title);
  }

  function modelOption(option) {
    const active = option.value === selectedValue;
    const item = action(`model-select-option${active ? " selected" : ""}`, "menuitemradio");
    item.setAttribute("aria-checked", String(active));
    item.setAttribute("data-selector-active", String(active));
    item.setAttribute("aria-label", option.providerLabel ? `${option.providerLabel} / ${option.label}` : option.label);
    item.disabled = option.disabled;
    item.dataset.modelId = option.value;
    const label = documentRoot.createElement("span");
    label.className = "model-select-option-label";
    label.textContent = option.label;
    const check = documentRoot.createElement("span");
    check.className = "model-select-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = active ? "✓" : "";
    item.append(label, check);
    item.addEventListener("click", () => onChoose(option.value));
    return item;
  }

  function showModels(group, withBack) {
    menu.setAttribute("aria-label", group.label ? `${group.label} models` : "Select model");
    if (withBack) {
      const back = action("model-select-back");
      back.dataset.selectorAction = "back";
      back.textContent = "‹  Providers";
      back.setAttribute("aria-label", "Back to providers");
      back.addEventListener("click", onBack);
      menu.appendChild(back);
    }
    heading(group.label || "Select model", "model-select-group-label");
    for (const option of group.options) menu.appendChild(modelOption(option));
  }

  const provider = groups.find((group) => group.id === providerId);
  if (provider) {
    showModels(provider, true);
    return;
  }
  if (groups.length === 1 && !groups[0].label) {
    showModels(groups[0], false);
    return;
  }

  menu.setAttribute("aria-label", "Select provider");
  heading("Select provider");
  for (const group of groups) {
    const item = action("model-select-provider-option");
    const label = group.label || "Other models";
    item.dataset.providerId = group.id;
    item.disabled = group.options.every((option) => option.disabled);
    item.setAttribute("aria-label", `${label} models`);
    item.setAttribute("data-selector-active", String(group.options.some((option) => option.value === selectedValue)));
    const description = documentRoot.createElement("span");
    description.className = "model-select-provider-description";
    const name = documentRoot.createElement("span");
    name.textContent = label;
    const count = documentRoot.createElement("span");
    count.className = "model-select-provider-count";
    count.textContent = `${group.options.length} ${group.options.length === 1 ? "model" : "models"}`;
    description.append(name, count);
    const arrow = documentRoot.createElement("span");
    arrow.textContent = "›";
    arrow.setAttribute("aria-hidden", "true");
    item.append(description, arrow);
    item.addEventListener("click", () => { if (!item.disabled) onBrowse(group.id); });
    menu.appendChild(item);
  }
}
