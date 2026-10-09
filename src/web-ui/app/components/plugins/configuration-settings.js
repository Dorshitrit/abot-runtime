import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

function renderSetting(name, value, fallback, index, overridden) {
  const attribute = `data-plugin-setting="${index}" data-plugin-setting-overridden="${overridden}"`;
  if (typeof fallback === "boolean")
    return `<label class="plugin-setting-checkbox"><input type="checkbox" ${attribute} ${value ? "checked" : ""}><span>${escapeHtml(name)}</span></label>`;
  if (typeof fallback === "number")
    return `<label><span>${escapeHtml(name)}</span><input type="number" step="any" ${attribute} value="${escapeAttribute(String(value))}" required></label>`;
  if (typeof fallback === "string")
    return `<label><span>${escapeHtml(name)}</span><input type="text" ${attribute} value="${escapeAttribute(String(value))}" autocomplete="off"></label>`;
  return `<label><span>${escapeHtml(name)} <small>JSON</small></span><textarea ${attribute} rows="4" spellcheck="false">${escapeHtml(JSON.stringify(value, null, 2))}</textarea></label>`;
}

export function renderPluginSettings(configuration) {
  return Object.entries(configuration.defaults || {})
    .map(([name, fallback], index) => {
      const overridden = (configuration.settingOverrides || []).includes(name);
      return `<div class="plugin-setting-field">
      ${renderSetting(name, configuration.settings[name], fallback, index, overridden)}
      <div class="plugin-setting-source"><small data-plugin-setting-origin="${index}">${overridden ? "Local value" : "Plugin default"}</small><button type="button" data-plugin-setting-default="${index}" data-plugin-setting-default-value="${escapeAttribute(JSON.stringify(fallback))}" aria-label="${escapeAttribute(`Use plugin default for ${name}`)}">Use plugin default</button></div>
    </div>`;
    })
    .join("");
}

function markPluginSettingSource(root, input, overridden) {
  input.dataset.pluginSettingOverridden = String(overridden);
  const status = root.querySelector(
    `[data-plugin-setting-origin="${input.dataset.pluginSetting}"]`,
  );
  if (status)
    status.textContent = overridden ? "Local value" : "Plugin default";
}

function restorePluginSettingDefault(input, fallback) {
  if (typeof fallback === "boolean") {
    input.checked = fallback;
    return;
  }
  if (typeof fallback === "object") {
    input.value = JSON.stringify(fallback, null, 2);
    return;
  }
  input.value = String(fallback);
}

export function bindPluginSettingFields(root, onChange) {
  for (const input of root.querySelectorAll("[data-plugin-setting]")) {
    input.addEventListener("input", () =>
      markPluginSettingSource(root, input, true),
    );
  }
  for (const button of root.querySelectorAll("[data-plugin-setting-default]")) {
    button.addEventListener("click", () => {
      const input = root.querySelector(
        `[data-plugin-setting="${button.dataset.pluginSettingDefault}"]`,
      );
      if (!input) return;
      const usesPluginDefault =
        input.dataset.pluginSettingOverridden === "false";
      if (usesPluginDefault) return;
      const fallback = JSON.parse(button.dataset.pluginSettingDefaultValue);
      restorePluginSettingDefault(input, fallback);
      markPluginSettingSource(root, input, false);
      onChange();
    });
  }
}

function readSetting(input, fallback, name) {
  if (typeof fallback === "boolean") return input.checked;
  if (typeof fallback === "string") return input.value;
  if (typeof fallback === "number") {
    if (!input.value.trim() || !Number.isFinite(Number(input.value)))
      throw new Error(`Enter a number for ${name}.`);
    return Number(input.value);
  }
  try {
    return JSON.parse(input.value);
  } catch {
    throw new Error(`Enter valid JSON for ${name}.`);
  }
}

function hasPluginSettingOverride(input, configuration, name) {
  const edited = input?.dataset?.pluginSettingOverridden;
  if (edited !== undefined) return edited === "true";
  return (configuration.settingOverrides || []).includes(name);
}

export function readPluginSettingOverrides(root, configuration) {
  return Object.fromEntries(
    Object.entries(configuration.defaults || {}).flatMap(
      ([name, fallback], index) => {
        const input = root?.querySelector(`[data-plugin-setting="${index}"]`);
        if (!hasPluginSettingOverride(input, configuration, name)) return [];
        return [
          [
            name,
            input
              ? readSetting(input, fallback, name)
              : configuration.settings[name],
          ],
        ];
      },
    ),
  );
}
