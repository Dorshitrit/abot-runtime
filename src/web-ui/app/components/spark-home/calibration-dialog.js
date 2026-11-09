import { escapeHtml } from "../../lib/text-format.js";

/** A bounded settings form, not another conversation or a HOME layout editor. */
export function createSparkHomeCalibrationDialog({ documentRoot = document, onChange, onDraft, onSave, onClose }) {
  const dialog = documentRoot.createElement("dialog");
  dialog.className = "spark-home-calibration";
  dialog.setAttribute("aria-labelledby", "spark-home-calibration-title");
  dialog.setAttribute("aria-describedby", "spark-home-calibration-description");
  dialog.innerHTML = `<form class="spark-home-calibration-form" novalidate>
    <header class="spark-home-calibration-heading"><div><span class="spark-home-calibration-eyebrow">YOUR HOME, YOUR DIRECTION</span>
      <h2 id="spark-home-calibration-title">Make room for what matters</h2></div>
      <button type="button" data-calibration-close aria-label="Close HOME setup">×</button></header>
    <div class="spark-home-calibration-content">
      <p id="spark-home-calibration-description">Start with a few choices, even if SPARK does not know you yet. These guide the content; SPARK still designs the screen.</p>
      <fieldset class="spark-home-calibration-path"><legend class="sr-only">How to write your instructions</legend>
        <label><input type="radio" name="home-calibration-path" value="guided" data-calibration-mode><span>Guide me</span></label>
        <label><input type="radio" name="home-calibration-path" value="manual" data-calibration-mode><span>I'll write my own</span></label></fieldset>
      <div data-calibration-guided>
        <fieldset class="spark-home-calibration-widgets"><legend>1. What would make HOME useful?</legend>
          <p>Pick only what you would use. These are content ideas, not a fixed layout.</p><div data-calibration-options></div></fieldset>
        <label class="spark-home-calibration-field"><span>2. What are you interested in?</span>
          <textarea spellcheck="false" data-calibration-field="topics" rows="2" maxlength="1000" dir="auto" placeholder="Topics, projects, or questions you want to keep up with"></textarea></label>
        <label class="spark-home-calibration-field"><span>3. How should HOME feel useful to you?</span>
          <textarea spellcheck="false" data-calibration-field="constraints" rows="2" maxlength="1000" dir="auto" placeholder="Your preferred language, level of detail, what to prioritize or leave out"></textarea></label>
        <div class="spark-home-calibration-draft-action"><button type="button" data-calibration-draft>Draft my instructions</button>
          <span>Uses your HOME model. Nothing is saved or built yet.</span></div>
      </div>
      <div data-calibration-preview hidden><label class="spark-home-calibration-field"><span data-calibration-preview-label>Your instructions</span>
        <textarea spellcheck="false" data-calibration-field="personalInstructions" rows="6" maxlength="4000" dir="auto" placeholder="Describe what you want HOME to show, what makes it useful, and what it should avoid."></textarea></label>
        <p class="spark-home-calibration-note">Review and edit before saving. These instructions apply only to HOME.</p></div>
      <p class="spark-home-calibration-status" data-calibration-status role="status" aria-live="polite"></p>
    </div>
    <footer class="spark-home-calibration-footer"><p>Saving also keeps the model currently selected in HOME.</p>
      <div><button type="button" data-calibration-cancel>Cancel</button><button type="button" data-calibration-save>Save HOME settings</button>
      <button type="submit" data-calibration-request>Save HOME settings and request screen</button></div></footer>
  </form>`;
  documentRoot.body.append(dialog);
  const find = (selector) => dialog.querySelector(selector);
  const fields = [...dialog.querySelectorAll("[data-calibration-field]")];
  const modes = [...dialog.querySelectorAll("[data-calibration-mode]")];
  const options = find("[data-calibration-options]");
  const close = find("[data-calibration-close]");
  const cancel = find("[data-calibration-cancel]");
  const draft = find("[data-calibration-draft]");
  const save = find("[data-calibration-save]");
  const request = find("[data-calibration-request]");
  const status = find("[data-calibration-status]");
  let optionsKey = "";
  let returnFocus;
  let wasPreview = false;
  for (const field of fields) field.addEventListener("input", () => onChange(field.dataset.calibrationField, field.value));
  for (const mode of modes) mode.addEventListener("change", () => onChange("mode", mode.value));
  options.addEventListener("change", () => onChange("widgetIds", [...options.querySelectorAll("input")].filter((input) => input.checked).map((input) => input.value)));
  close.addEventListener("click", onClose); cancel.addEventListener("click", onClose);
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); onClose(); });
  dialog.addEventListener("close", () => { if (!dialog.open) onClose(); });
  draft.addEventListener("click", () => void onDraft());
  save.addEventListener("click", () => void onSave(false));
  find("form").addEventListener("submit", (event) => { event.preventDefault(); if (!request.disabled) void onSave(true); });
  function renderOptions(state, busy) {
    const key = JSON.stringify(state.options);
    if (key !== optionsKey) {
      optionsKey = key;
      options.innerHTML = state.options.map((option) => `<label class="spark-home-calibration-choice">
        <input type="checkbox" value="${escapeHtml(option.id)}"><span><strong>${escapeHtml(option.label)}</strong>
        <small>${escapeHtml(option.description)}</small>${option.available ? "" : `<small class="spark-home-calibration-unavailable">${escapeHtml(option.reason || "Unavailable with this model")}</small>`}</span></label>`).join("");
    }
    for (const input of options.querySelectorAll("input")) {
      input.checked = state.answers.widgetIds.includes(input.value);
      input.disabled = busy || (!input.checked && !state.options.find((option) => option.id === input.value)?.available);
    }
  }
  function renderOpenState(state) {
    if (state.open && !dialog.open) {
      returnFocus = documentRoot.activeElement;
      dialog.showModal(); close.focus();
    }
    if (!state.open && dialog.open) {
      dialog.close();
      if (returnFocus?.isConnected !== false && !returnFocus?.closest("[hidden], [inert]")) returnFocus?.focus();
      returnFocus = undefined;
    }
  }
  return {
    render(state) {
      const busy = state.loading || state.drafting || state.saving;
      const showPreview = state.mode === "manual" || state.preview;
      for (const field of fields) {
        const value = state.answers[field.dataset.calibrationField];
        if (field.value !== value) field.value = value;
        field.disabled = busy;
      }
      for (const mode of modes) { mode.checked = mode.value === state.mode; mode.disabled = busy; }
      renderOptions(state, busy);
      find("[data-calibration-guided]").hidden = state.mode !== "guided";
      find("[data-calibration-preview]").hidden = !showPreview;
      find("[data-calibration-preview-label]").textContent = state.mode === "manual" ? "Your instructions" : "Review your instructions";
      draft.disabled = busy; draft.textContent = state.drafting ? "Drafting…" : "Draft my instructions";
      save.disabled = busy || !showPreview || !state.answers.personalInstructions.trim();
      request.disabled = save.disabled;
      close.disabled = state.saving; cancel.disabled = state.saving;
      status.textContent = state.error || (state.loading ? "Loading your HOME choices…" : state.drafting ? "Shaping your instructions…" : state.saving ? "Saving HOME settings…" : "");
      status.dataset.tone = state.error ? "error" : "status";
      dialog.setAttribute("aria-busy", String(busy));
      renderOpenState(state);
      if (state.open && state.preview && !wasPreview && !busy) fields.find((field) => field.dataset.calibrationField === "personalInstructions")?.focus();
      wasPreview = state.preview;
    },
  };
}
