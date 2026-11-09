import { escapeHtml } from "../../lib/text-format.js";
import { modelSelectorOptions } from "../../lib/model-selector-options.js";

/** Settings only; creating a screen remains an explicit SPARK request. */
export function createSparkHomeSettingsView({ root, onChange, onSave, onReload, onCalibrate = () => {} }) {
  const panel = root?.querySelector('[data-learning-panel="home"]');
  if (!panel) return { render() {}, focus() {} };
  panel.innerHTML = `<form class="spark-home-settings co-worker-settings" data-spark-home-settings novalidate>
    <header class="co-worker-settings-header">
      <div class="co-worker-settings-intro"><h4>Your HOME</h4><p>Give SPARK direction for a personal home screen. Leave room for it to decide what is useful.</p></div>
      <button type="submit" data-home-settings-save disabled>Save settings</button>
    </header>
    <section class="co-worker-settings-card">
      <div class="spark-home-calibration-intro"><p>A few choices can help you shape a useful first screen.</p><button type="button" data-home-calibrate>Help me shape HOME</button></div>
      <label class="co-worker-setting-field" for="spark-home-instructions"><span>Personal instructions</span>
        <textarea spellcheck="false" id="spark-home-instructions" data-home-setting="personalInstructions" maxlength="4000" rows="5" dir="auto" placeholder="What would you like HOME to help you with? What should it avoid?" aria-describedby="spark-home-instructions-note"></textarea></label>
      <p class="co-worker-setting-note" id="spark-home-instructions-note">Save a direction before creating your first screen. Used only for HOME; saving does not change the current screen.</p>
      <label class="co-worker-setting-field" for="spark-home-model"><span>HOME model</span>
        <select id="spark-home-model" data-home-setting="modelProfileId" aria-describedby="spark-home-model-note"></select></label>
      <p class="co-worker-setting-note" id="spark-home-model-note">Choose and save an EA model for HOME. It handles planning, research and building the screen. Other SPARK conversations keep their model.</p>
      <p class="co-worker-setting-note" data-home-model-feedback role="status"></p>
    </section>
    <section class="spark-home-settings-future"><h4>Scheduling</h4><p>Automatic refresh is planned for a later version. Create a new screen when you choose.</p></section>
    <section class="spark-home-settings-future" aria-label="Future HOME features"><h4>Screen history and feedback</h4><p>A place for past screens and your feedback is planned for a future update.</p></section>
    <footer class="co-worker-settings-footer"><span data-home-settings-feedback role="status" aria-live="polite"></span><button type="button" data-home-settings-reload hidden>Reload saved settings</button></footer>
  </form>`;
  const form = panel.querySelector("[data-spark-home-settings]");
  const field = (name) => form.querySelector(`[data-home-setting="${name}"]`);
  const save = form.querySelector("[data-home-settings-save]");
  const reload = form.querySelector("[data-home-settings-reload]");
  let modelOptionsKey = "";
  function changed(event) {
    const name = event.target.dataset.homeSetting;
    if (!name) return;
    onChange(name, event.target.type === "checkbox" ? event.target.checked : event.target.value);
  }
  form.addEventListener("input", changed);
  form.addEventListener("change", changed);
  form.addEventListener("submit", (event) => { event.preventDefault(); if (!save.disabled) void onSave(); });
  reload.addEventListener("click", () => void onReload());
  form.querySelector("[data-home-calibrate]").addEventListener("click", () => void onCalibrate());
  return {
    focus(name) { field(name)?.focus(); },
    render(state) {
      const values = state.values;
      const optionsKey = JSON.stringify([state.models, values.modelProfileId]);
      if (optionsKey !== modelOptionsKey) {
        modelOptionsKey = optionsKey;
        const missing = values.modelProfileId && !state.models.some((model) => model.id === values.modelProfileId);
        field("modelProfileId").innerHTML = '<option value="">Choose a HOME model</option>'
          + (missing ? `<option value="${escapeHtml(values.modelProfileId)}" disabled>${escapeHtml(values.modelProfileId)} · Unavailable</option>` : "")
          + modelSelectorOptions(state.models).map((model) => `<option value="${escapeHtml(model.value)}">${escapeHtml(model.providerLabel ? `${model.providerLabel} - ${model.label}` : model.label)}</option>`).join("");
      }
      for (const [name, value] of Object.entries(values)) {
        const control = field(name);
        if (control.type === "checkbox") control.checked = value;
        else if (control.value !== value) control.value = value;
        control.disabled = !state.ready || state.loading || state.saving;
      }
      form.querySelector("[data-home-calibrate]").disabled = !state.ready || state.loading || state.saving || state.conflict || state.reloadRequired;
      save.disabled = !state.ready || state.loading || state.saving || state.conflict || state.reloadRequired || !state.changed;
      save.textContent = state.saving ? "Saving…" : "Save settings";
      reload.hidden = !(state.error || state.conflict);
      reload.disabled = state.loading || state.saving;
      form.querySelector("[data-home-model-feedback]").textContent = state.modelsError;
      form.querySelector("[data-home-settings-feedback]").textContent = state.loading ? "Loading HOME settings…"
        : state.error || state.feedback || (state.changed ? "Unsaved changes" : "");
    },
  };
}
