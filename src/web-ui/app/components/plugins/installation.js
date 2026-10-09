import { createPluginConfigurationDraft } from "./configuration-draft.js";
import {
  bindPluginConfigurationFields,
  clearPluginSecretInputs,
  readPluginConfigurationFields,
} from "./configuration-fields.js";
/** The review is tied to exact bytes and the currently selected environment. */
export function createPluginInstallation({
  inspectPlugin,
  installPlugin,
  getEnvironmentId,
  beginRuntimeMutation,
  endRuntimeMutation,
  refreshRuntimeConfig,
  onConfigurationSaved,
  onInstalled,
  render,
}) {
  const state = {
    source: { repository: "", ref: "", path: "" },
    review: null,
    installedPluginId: null,
    dirty: false,
    busy: false,
    error: "",
    message: "",
  };
  const draft = createPluginConfigurationDraft();
  let generation = 0;
  let mountedRoot = null;
  let environment = getEnvironmentId();

  function resetEnvironment() {
    if (environment === getEnvironmentId()) return;
    environment = getEnvironmentId();
    generation += 1;
    state.dirty = false;
    state.review = null;
    state.installedPluginId = null;
    state.busy = false;
    state.error = "";
    state.message = "";
  }

  function isCurrentInstallationRequest(request, selected) {
    return request === generation && selected === getEnvironmentId();
  }

  async function inspect(source = state.source) {
    resetEnvironment();
    if (state.busy || !inspectPlugin) return false;
    state.source = { ...source };
    state.dirty = false;
    state.review = null;
    state.installedPluginId = null;
    state.error = "";
    state.message = "";
    state.busy = true;
    const request = ++generation;
    const selected = environment;
    render();
    try {
      const result = await inspectPlugin(state.source, selected);
      if (!isCurrentInstallationRequest(request, selected)) return false;
      state.review = result.review;
      return true;
    } catch (error) {
      if (isCurrentInstallationRequest(request, selected))
        state.error = error.message || String(error);
      return false;
    } finally {
      if (isCurrentInstallationRequest(request, selected)) {
        state.busy = false;
        render();
      }
    }
  }

  async function install(fields) {
    resetEnvironment();
    if (state.busy || !state.review || !installPlugin) return false;
    let configuration;
    try {
      if (state.review.configuration)
        configuration = readPluginConfigurationFields(
          fields,
          state.review.configuration,
          true,
        );
    } catch (error) {
      state.error = error.message;
      const status = mountedRoot?.querySelector("[data-plugin-install-status]");
      if (status) status.textContent = state.error;
      return false;
    }
    if (!beginRuntimeMutation("plugin installation")) return false;
    if (configuration) {
      state.review.configuration.settings = {
        ...state.review.configuration.defaults,
        ...configuration.settings,
      };
      state.review.configuration.settingOverrides = Object.keys(
        configuration.settings,
      );
    }
    clearPluginSecretInputs(fields);
    const review = state.review;
    const selected = environment;
    const request = ++generation;
    state.busy = true;
    state.error = "";
    let installed = false;
    render();
    try {
      const result = await installPlugin(
        {
          source: review.source,
          digest: review.digest,
          ...(configuration ? { configuration } : {}),
        },
        selected,
      );
      installed = true;
      if (!isCurrentInstallationRequest(request, selected)) return false;
      state.dirty = false;
      state.review = null;
      state.installedPluginId = review.id;
      state.message = `${review.id} installed. Apply changes to make it available.`;
      onInstalled(result);
      onConfigurationSaved();
      const refreshed = await refreshRuntimeConfig(
        "Plugin installed; refresh required",
      );
      if (!isCurrentInstallationRequest(request, selected)) return false;
      if (!refreshed)
        state.message =
          "Plugin installed. Refresh configuration before applying changes.";
      return true;
    } catch (error) {
      if (isCurrentInstallationRequest(request, selected))
        state.error =
          (installed
            ? "Plugin installed; configuration refresh failed: "
            : "") + (error.message || String(error));
      return false;
    } finally {
      configuration = undefined;
      endRuntimeMutation();
      if (isCurrentInstallationRequest(request, selected)) {
        state.busy = false;
        render();
      }
    }
  }

  function bind(root) {
    mountedRoot = root;
    draft.restore(root, state.review, state.busy);
    const form = root.querySelector("[data-plugin-source-form]");
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      void inspect({
        repository: form.elements.repository.value.trim(),
        ref: form.elements.ref.value.trim(),
        path: form.elements.path.value.trim(),
      });
    });
    form?.addEventListener("input", () => {
      state.source = {
        repository: form.elements.repository.value,
        ref: form.elements.ref.value,
        path: form.elements.path.value,
      };
      if (!state.review) return;
      draft.clear();
      state.dirty = false;
      state.review = null;
      root.querySelector(".plugin-install-review")?.remove();
    });
    const fields = root.querySelector("[data-plugin-configuration-fields]");
    bindPluginConfigurationFields(fields, () => {
      state.dirty = true;
    });
    root
      .querySelector("[data-plugin-review-cancel]")
      ?.addEventListener("click", () => {
        clearPluginSecretInputs(fields);
        state.review = null;
        state.dirty = false;
        state.error = "";
        render();
      });
    for (const button of root.querySelectorAll("[data-plugin-install-confirm]"))
      button.addEventListener("click", () => void install(fields));
  }

  function markApplied() {
    resetEnvironment();
    if (state.message)
      state.message = "Plugin installation applied to this environment.";
  }

  return {
    state,
    bind,
    inspect,
    install,
    resetEnvironment,
    markApplied,
    captureFields: (root) => draft.capture(root, state.review, state.busy),
  };
}
