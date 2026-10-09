import {
  renderPluginSettings,
  bindPluginSettingFields,
  readPluginSettingOverrides,
} from "./configuration-settings.js";
import {
  renderRetainedPluginSecrets,
  readRetainedPluginSecretClears,
} from "./configuration-retained-secrets.js";
import { escapeAttribute, escapeHtml } from "../../lib/text-format.js";

function renderSecret(secret, index) {
  return `<div class="plugin-secret-field">
    <label><span>${escapeHtml(secret.name)}${secret.required ? " (required)" : ""}</span>
      <small>${escapeHtml(secret.env)} · ${secret.configured ? "Configured" : "Not configured"}</small>
      <select data-plugin-secret-action="${index}" aria-label="${escapeAttribute(`Action for ${secret.name}`)}"><option value="keep">Keep current value</option><option value="set">Replace value</option><option value="clear">Clear value</option></select>
    </label>
    <input type="password" data-plugin-secret-value="${index}" aria-label="${escapeAttribute(`New value for ${secret.name}`)}" autocomplete="new-password" disabled hidden>
  </div>`;
}

export function renderPluginConfigurationFields(configuration, busy = false) {
  if (!configuration) return "";
  const entries = Object.entries(configuration.defaults || {});
  const secrets = configuration.secrets || [];
  const retained = configuration.retainedSecrets || [];
  if (!entries.length && !secrets.length && !retained.length) return "";
  return `<fieldset class="plugin-configuration-fields" data-plugin-configuration-fields ${busy ? "disabled" : ""}>
    <legend>Configuration</legend>
    <p>Shared across environments in this ABot installation. Saved values stay local and are retained when the plugin is removed.</p>
    ${renderPluginSettings(configuration)}
    ${secrets.map(renderSecret).join("")}
    ${renderRetainedPluginSecrets(retained)}
  </fieldset>`;
}

const boundFields = new WeakSet();

export function bindPluginConfigurationFields(root, onChange = () => {}) {
  if (!root || boundFields.has(root)) return;
  boundFields.add(root);
  bindPluginSettingFields(root, onChange);
  root?.addEventListener("input", onChange);
  for (const select of root?.querySelectorAll("[data-plugin-secret-action]") ||
    []) {
    select.addEventListener("change", () => {
      const input = root.querySelector(
        `[data-plugin-secret-value="${select.dataset.pluginSecretAction}"]`,
      );
      input.hidden = select.value !== "set";
      input.disabled = select.value !== "set";
      input.required = select.value === "set";
      if (select.value !== "set") input.value = "";
      onChange();
    });
  }
}

/** Secrets exist only in password controls and the one outbound save payload. */
export function readPluginConfigurationFields(
  root,
  configuration,
  requireSecrets = false,
) {
  const settings = readPluginSettingOverrides(root, configuration);
  const secrets = Object.create(null);
  for (const [index, secret] of (configuration.secrets || []).entries()) {
    const action =
      root?.querySelector(`[data-plugin-secret-action="${index}"]`)?.value ||
      "keep";
    if (action === "set") {
      const value = root.querySelector(
        `[data-plugin-secret-value="${index}"]`,
      ).value;
      if (!value.trim()) throw new Error(`Enter a value for ${secret.name}.`);
      secrets[secret.name] = { action, value };
      continue;
    }
    if (
      requireSecrets &&
      secret.required &&
      (action === "clear" || !secret.configured)
    )
      throw new Error(`Configure ${secret.name} before installing.`);
    if (action === "clear") secrets[secret.name] = { action };
  }
  const clearRetainedSecrets = readRetainedPluginSecretClears(
    root,
    configuration.retainedSecrets,
  );
  return {
    revision: configuration.revision,
    settings,
    secrets,
    ...(clearRetainedSecrets.length ? { clearRetainedSecrets } : {}),
  };
}

export function clearPluginSecretInputs(root) {
  for (const input of root?.querySelectorAll("[data-plugin-secret-value]") ||
    [])
    input.value = "";
}
