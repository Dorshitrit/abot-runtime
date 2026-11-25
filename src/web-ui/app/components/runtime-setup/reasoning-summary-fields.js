import { readReasoningSummarySelection, reasoningSummaryLabel, renderReasoningSummaryOptions } from "../../lib/reasoning-summary-presentation.js";

/** New models default Off; omission on an existing model preserves its saved option. */
export function setupReasoningSummaryState(model) {
  return { reasoningSummary: model === undefined ? null : model.reasoningSummary };
}

export function updateSetupReasoningSummaryField(state, field, value) {
  if (field !== "reasoning-summary") return false;
  const selected = value === "" ? null : value;
  if (readReasoningSummarySelection(selected) === "unsupported") return true;
  state.reasoningSummary = selected;
  return true;
}

export function setupReasoningSummaryInput(provider, value) {
  if (provider !== "openai") return {};
  if (value === undefined) return {};
  if (readReasoningSummarySelection(value) === "unsupported") return {};
  return { reasoningSummary: value };
}

export function hasSetupReasoningSummaryChanges(state) {
  if (state.provider !== "openai") return false;
  return state.reasoningSummary !== state.existingModel?.reasoningSummary;
}

export function renderSetupReasoningSummaryField(state, readonly = false) {
  if ((state.providerType || state.provider) !== "openai") return "";
  return `<label class="runtime-setup-field"><span>Reasoning summary</span>
    <select data-runtime-setup-field="reasoning-summary" ${readonly ? "disabled" : ""}>${renderReasoningSummaryOptions(state.reasoningSummary)}</select>
    <small>Show a summary of the model's reasoning. Auto uses the most detailed summary the model supports. No summary is requested while reasoning is Off.</small>
  </label>`;
}

export function renderSetupReasoningSummaryReview(provider, value) {
  if (provider !== "openai") return "";
  return `<div><dt>Reasoning summary</dt><dd>${reasoningSummaryLabel(value)}</dd></div>`;
}
