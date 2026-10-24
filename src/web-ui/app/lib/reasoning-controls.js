import { reasoningPreferenceLabel, renderReasoningPreferenceField, syncReasoningPreferenceField } from "./reasoning-preference.js";
import { escapeHtml } from "./text-format.js";

export function displayReasoningMode(mode, preference) {
  if (preference) return `${agentModeMeta(mode).label} · ${reasoningPreferenceLabel(preference)}`;
  if (mode === "fast") return "Low";
  return mode;
}

export function canChooseReasoning(profile) {
  return profile?.supportsThinking === true;
}

/** Keep the stored mode for compatibility while showing the effective provider default. */
export function reasoningModeOptions(mode, enabled, modes = ["fast", "reasoning", "deep"]) {
  if (!enabled) return `<option value="${escapeHtml(mode || "reasoning")}">Provider default</option>`;
  const labels = { fast: "Low", reasoning: "Reasoning", deep: "Deep", auto: "Auto" };
  return modes.map((value) => `<option value="${escapeHtml(value)}"${value === mode ? " selected" : ""}>${escapeHtml(labels[value] || value)}</option>`).join("");
}

export function agentModeMeta(mode) {
  const modes = {
    auto: { label: "Auto", description: "Lets the agent choose", icon: "*" },
    fast: { label: "Low", description: "Shorter and quicker", icon: "!" },
    reasoning: { label: "Reasoning", description: "Balanced speed and thinking", icon: "R" },
    deep: { label: "Deep", description: "More careful responses", icon: "D" },
  };
  return modes[mode] || modes.reasoning;
}

export function renderReasoningModeButtons(mode, modes, disabled = false) {
  return modes.map((value) => {
    const item = agentModeMeta(value);
    const selected = value === mode;
    return `<button class="agent-mode-option ${selected ? "selected" : ""}" type="button"
      role="menuitemradio" aria-checked="${selected}" tabindex="${selected ? "0" : "-1"}"
      data-mode="${escapeHtml(value)}" ${disabled ? "disabled" : ""}>
      <span class="agent-mode-option-icon">${escapeHtml(item.icon)}</span>
      <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.description)}</small></span>
    </button>`;
  }).join("");
}

export function renderReasoningModeField(mode, profile, modes, preference) {
  const enabled = canChooseReasoning(profile);
  return `<label data-legacy-reasoning>Reasoning depth<select name="agentMode" data-reasoning-mode data-retained-mode="${escapeHtml(mode || "reasoning")}"${enabled ? "" : " disabled"}>${reasoningModeOptions(mode, enabled, modes)}</select>
    <small data-reasoning-mode-note${enabled ? " hidden" : ""}>Uses the provider default. Enable reasoning controls for this model in Models.</small>
    <small data-reasoning-default-note${enabled ? "" : " hidden"}>Sets the default depth; model profile and calibration settings may override it. Token budgets are separate. Changing the mode turns Thinking Off back on.</small></label>${renderReasoningPreferenceField(profile, preference)}`;
}

export function syncReasoningModeField(form, profiles, modes) {
  const select = form?.querySelector("[data-reasoning-mode]");
  if (!select) return;
  const profileId = form.querySelector('[name="modelProfileId"]')?.value;
  const profile = profiles?.find((item) => item.id === profileId);
  const enabled = canChooseReasoning(profile);
  syncReasoningPreferenceField(form, profile);
  const mode = select.value || select.dataset.retainedMode || "reasoning";
  select.dataset.retainedMode = mode;
  select.innerHTML = reasoningModeOptions(mode, enabled, modes);
  select.disabled = !enabled;
  const note = form.querySelector("[data-reasoning-mode-note]");
  if (note) note.hidden = enabled;
  const defaultNote = form.querySelector("[data-reasoning-default-note]");
  if (defaultNote) defaultNote.hidden = !enabled;
}

export function clearReasoningOffForMode(form, profiles, modes) {
  const select = form.querySelector("[data-reasoning-mode]");
  if (!select?.value || select.disabled) return;
  select.dataset.retainedMode = select.value;
  const preferenceMode = form.querySelector("[data-reasoning-preference-mode]");
  if (preferenceMode?.value !== "off") return;
  preferenceMode.value = "inherit";
  syncReasoningModeField(form, profiles, modes);
}

export function retainedReasoningMode(form, fallback) {
  const select = form.querySelector("[data-reasoning-mode]");
  return select?.value || select?.dataset.retainedMode || fallback;
}
