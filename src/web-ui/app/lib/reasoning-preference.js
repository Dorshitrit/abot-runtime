import { escapeHtml } from "./text-format.js";

export const MAX_REASONING_BUDGET_TOKENS = 2147483647;
export function canChooseReasoningBudget(profile) {
  return profile?.supportsThinking === true && profile?.reasoningControls?.budgetTokens === true;
}
export function isReasoningPreference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.profileId !== "string" || !value.profileId.trim()) return false;
  if (!["off", "budget", "server-default"].includes(value.mode)) return false;
  const fields = value.mode === "budget" ? ["profileId", "mode", "budgetTokens"] : ["profileId", "mode"];
  if (Object.keys(value).some((key) => !fields.includes(key))) return false;
  return value.mode !== "budget" || (Number.isInteger(value.budgetTokens)
    && value.budgetTokens >= 0 && value.budgetTokens <= MAX_REASONING_BUDGET_TOKENS);
}
export function reasoningPreferenceLabel(preference) {
  const zeroBudgetDisablesThinking = preference?.mode === "budget" && preference.budgetTokens === 0;
  if (zeroBudgetDisablesThinking) return "Thinking off";
  if (preference?.mode === "budget") return `${preference.budgetTokens} thinking tokens`;
  if (preference?.mode === "off") return "Thinking off";
  if (preference?.mode === "server-default") return "Server thinking default";
  return "Profile default";
}
export function renderReasoningPreferenceField(profile, preference) {
  const available = canChooseReasoningBudget(profile);
  const mode = preference?.mode || "inherit";
  const profileId = profile?.id || preference?.profileId || "";
  return `<div data-reasoning-preference data-profile-id="${escapeHtml(profileId)}" data-budget-available="${available}"${available || preference ? "" : " hidden"}>
    <label>Thinking budget<select name="reasoningPreferenceMode" data-reasoning-preference-mode>
      ${[["inherit", "Profile default"], ["off", "Off"], ["budget", "Custom token budget"], ["server-default", "Server default"]].map(([value, label]) => `<option value="${value}"${value === mode ? " selected" : ""}${!available && value !== "inherit" ? " disabled" : ""}>${label}</option>`).join("")}
    </select></label>
    <label data-reasoning-budget-label${mode === "budget" ? "" : " hidden"}>Thinking tokens<input name="reasoningBudgetTokens" data-reasoning-budget type="number" min="0" max="${MAX_REASONING_BUDGET_TOKENS}" step="1" inputmode="numeric" value="${preference?.mode === "budget" ? escapeHtml(String(preference.budgetTokens)) : ""}"${mode === "budget" ? " required" : " disabled"}></label>
    <small data-reasoning-preference-note>${available ? "The token limit is independent of reasoning depth and counts toward the total output limit. Off or a token limit of 0 disables thinking." : "This model cannot use the saved thinking budget. Choose Profile default to clear it."}</small>
  </div><small data-reasoning-model-change-note hidden>Changing the model reset the thinking budget to Profile default.</small>`;
}
export function syncReasoningPreferenceField(form, profile) {
  const field = form?.querySelector("[data-reasoning-preference]");
  if (!field) return;
  const changed = field.dataset.profileId !== (profile?.id || "");
  const mode = field.querySelector("[data-reasoning-preference-mode]");
  const notice = form.querySelector("[data-reasoning-model-change-note]");
  if (changed) {
    if (notice) notice.hidden = mode.value === "inherit";
    field.dataset.profileId = profile?.id || "";
    mode.value = "inherit";
    field.querySelector("[data-reasoning-budget]").value = "";
  }
  const available = canChooseReasoningBudget(profile);
  field.dataset.budgetAvailable = String(available);
  field.hidden = !available && mode.value === "inherit";
  for (const option of mode.querySelectorAll("option")) option.disabled = !available && option.value !== "inherit";
  if (!changed && mode.value !== "inherit" && notice) notice.hidden = true;
  const custom = mode.value === "budget";
  field.querySelector("[data-reasoning-budget-label]").hidden = !custom;
  const input = field.querySelector("[data-reasoning-budget]");
  input.disabled = !custom; input.required = custom;
}
function readReasoningBudgetTokens(field) {
  const raw = field.querySelector("[data-reasoning-budget]").value;
  if (raw.trim() === "") return NaN;
  return Number(raw);
}

export function readReasoningPreferenceField(form) {
  const field = form?.querySelector("[data-reasoning-preference]");
  const mode = field?.querySelector("[data-reasoning-preference-mode]")?.value || "inherit";
  if (mode === "inherit") return undefined;
  if (field.dataset.budgetAvailable !== "true")
    throw new Error("This model does not support thinking budgets. Choose Profile default.");
  const preference = { profileId: field.dataset.profileId, mode };
  if (mode === "budget") preference.budgetTokens = readReasoningBudgetTokens(field);
  if (!isReasoningPreference(preference))
    throw new Error(`Enter a whole thinking token budget from 0 to ${MAX_REASONING_BUDGET_TOKENS}; 0 disables thinking.`);
  return preference;
}
