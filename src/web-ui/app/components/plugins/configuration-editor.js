import { escapeHtml } from "../../lib/text-format.js";
import {
  bindPluginConfigurationFields,
  clearPluginSecretInputs,
  readPluginConfigurationFields,
  renderPluginConfigurationFields,
} from "./configuration-fields.js";

/** A mounted dialog preserves password controls across dashboard rerenders. */
export function createPluginConfigurationEditor({
  loadConfiguration,
  saveConfiguration,
  getEnvironmentId,
  beginRuntimeMutation,
  endRuntimeMutation,
  onConfigurationSaved,
  onClosed = () => {},
}) {
  let dialog = null;
  let busy = false;
  let configuration = null;
  let environment = "";
  let generation = 0;

  function close() {
    if (busy || !dialog) return false;
    generation += 1;
    clearPluginSecretInputs(dialog);
    dialog.close?.();
    dialog.remove();
    dialog = null;
    configuration = null;
    endRuntimeMutation();
    onClosed();
    return true;
  }

  function message(text, failed = false) {
    const status = dialog?.querySelector("[data-plugin-configuration-status]");
    if (!status) return;
    status.textContent = text;
    status.className = failed ? "error-text" : "";
  }

  function setBusy(value) {
    busy = value;
    const fields = dialog?.querySelector("fieldset");
    if (fields) fields.disabled = value;
    for (const button of dialog?.querySelectorAll("button") || [])
      button.disabled = value;
  }

  async function save() {
    if (busy || !configuration) return false;
    if (environment !== getEnvironmentId()) return false;
    let input;
    try {
      input = readPluginConfigurationFields(dialog, configuration);
    } catch (error) {
      message(error.message, true);
      return false;
    }
    setBusy(true);
    message("Saving…");
    try {
      const result = await saveConfiguration(
        configuration.pluginId,
        input,
        environment,
      );
      configuration = result.configuration;
      onConfigurationSaved();
      message(
        "Saved. Close this form, then Apply changes to use these values.",
      );
      clearPluginSecretInputs(dialog);
      const fields = dialog.querySelector("[data-plugin-configuration-body]");
      fields.innerHTML = renderPluginConfigurationFields(configuration);
      bindPluginConfigurationFields(fields.querySelector("fieldset"), () =>
        message("Unsaved changes. Save to keep them."),
      );
      return true;
    } catch (error) {
      // Do not project transport payloads or an entered password into HTML or logs.
      clearPluginSecretInputs(dialog);
      message(
        error.message || "Plugin configuration could not be saved.",
        true,
      );
      return false;
    } finally {
      input = undefined;
      setBusy(false);
    }
  }

  async function open(pluginId, root) {
    if (dialog || !root?.ownerDocument || !loadConfiguration) return false;
    if (!beginRuntimeMutation("plugin configuration")) return false;
    environment = getEnvironmentId();
    const request = ++generation;
    dialog = root.ownerDocument.createElement("dialog");
    dialog.className = "plugin-configuration-dialog";
    dialog.setAttribute("aria-label", `Configure ${pluginId}`);
    dialog.innerHTML = `<form><h2 tabindex="-1" autofocus>Configure ${escapeHtml(pluginId)}</h2><div data-plugin-configuration-body></div><p data-plugin-configuration-status role="status" aria-live="polite">Loading…</p><div class="plugin-configuration-actions"><button type="button" data-plugin-configuration-close>Close</button><button type="submit" class="primary-button">Save changes</button></div></form>`;
    root.ownerDocument.body.append(dialog);
    dialog.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      void save();
    });
    dialog
      .querySelector("[data-plugin-configuration-close]")
      .addEventListener("click", close);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    dialog.showModal();
    setBusy(true);
    try {
      const result = await loadConfiguration(pluginId, environment);
      if (request !== generation || environment !== getEnvironmentId())
        return false;
      configuration = result.configuration;
      const fields = dialog.querySelector("[data-plugin-configuration-body]");
      fields.innerHTML = renderPluginConfigurationFields(configuration);
      bindPluginConfigurationFields(fields.querySelector("fieldset"), () =>
        message("Unsaved changes. Save to keep them."),
      );
      message(
        "Changes take effect after Apply. Clearing a required key prevents the plugin from loading until it is configured again.",
      );
      return true;
    } catch (error) {
      message(
        error.message || "Plugin configuration could not be loaded.",
        true,
      );
      return false;
    } finally {
      setBusy(false);
      if (environment !== getEnvironmentId()) close();
    }
  }

  return { open, close, save, isOpen: () => Boolean(dialog) };
}
