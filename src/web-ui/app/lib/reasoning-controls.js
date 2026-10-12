import { escapeHtml } from "./text-format.js";

export function canChooseReasoning(profile) {
  return profile?.supportsThinking === true;
}

/** Keep the stored mode for compatibility while showing the effective provider default. */
export function reasoningModeOptions(mode, enabled, modes = ["fast", "reasoning", "deep"]) {
  if (!enabled) return `<option value="${escapeHtml(mode || "reasoning")}">Provider default</option>`;
  const labels = { fast: "Fast", reasoning: "Reasoning", deep: "Deep", auto: "Auto" };
  return modes.map((value) => `<option value="${escapeHtml(value)}"${value === mode ? " selected" : ""}>${escapeHtml(labels[value] || value)}</option>`).join("");
}

export function renderReasoningModeField(mode, profile, modes) {
  const enabled = canChooseReasoning(profile);
  return `<label>Reasoning depth<select name="agentMode" data-reasoning-mode${enabled ? "" : " disabled"}>${reasoningModeOptions(mode, enabled, modes)}</select>
    <small data-reasoning-mode-note${enabled ? " hidden" : ""}>Uses the provider default. Enable reasoning controls for this model in Models.</small></label>`;
}

export function syncReasoningModeField(form, profiles, modes) {
  const select = form?.querySelector("[data-reasoning-mode]");
  if (!select) return;
  const profileId = form.querySelector('[name="modelProfileId"]')?.value;
  const profile = profiles?.find((item) => item.id === profileId);
  const enabled = canChooseReasoning(profile);
  const mode = select.value;
  select.innerHTML = reasoningModeOptions(mode, enabled, modes);
  select.disabled = !enabled;
  const note = form.querySelector("[data-reasoning-mode-note]");
  if (note) note.hidden = enabled;
}

export function retainedReasoningMode(form, fallback) {
  return form.querySelector("[data-reasoning-mode]")?.value || fallback;
}
