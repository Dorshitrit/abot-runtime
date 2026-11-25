import { escapeHtml as html, escapeAttribute as attr } from "../../lib/text-format.js";
import { groupModelSelectorOptions, modelSelectorOptions } from "../../lib/model-selector-options.js";
import { AGENT_COLORS, AGENT_FOCUS, AGENT_OUTPUTS, AGENT_STYLES, AGENT_ASKS, AGENT_UPDATES, AGENT_BUDGETS, AGENT_LIMIT_FIELDS, agentDraftLimits } from "./onboarding-options.js";
function choices(group, values, selected) {
  return `<div class="agents-chips" role="group" aria-label="${attr(group)}">${Object.entries(values).map(([key, value]) => `<button type="button" data-agent-choice="${attr(group)}" data-value="${attr(key)}" aria-pressed="${Array.isArray(selected) ? selected.includes(key) : selected === key}">${html(typeof value === "string" ? value : value.label)}</button>`).join("")}</div>`;
}
function modelChoices(models, selected) {
  const profiles = models.map((model) => ({ ...model, label: model.label || model.name }));
  return groupModelSelectorOptions(modelSelectorOptions(profiles)).map(({ label, options }) => {
    const buttons = options.map((option) => `<button type="button" data-agent-choice="modelProfileId" data-value="${attr(option.value)}" aria-pressed="${option.value === selected}">${html(option.label)}</button>`);
    return `<fieldset class="agents-model-provider"><legend>${html(label || "Other models")}</legend><div class="agents-chips">${buttons.join("")}</div></fieldset>`;
  }).join("");
}
function identity(draft, models, context, previewText) {
  return `<label class="agents-label">Name<input name="name" dir="auto" spellcheck="false" maxlength="40" required value="${attr(draft.name)}" placeholder="Give them a name" autocomplete="off"></label>
  <div><span class="agents-label">Model</span>${modelChoices(models, draft.modelProfileId)}<p class="agents-hint">This agent and its work sessions use the same model.</p>${models.length ? "" : '<p class="agents-error">Configure an available model in Models first.</p>'}</div>
  <div><span class="agents-label">Color</span><div class="agents-color-picks" role="group" aria-label="Agent color">${Object.entries(AGENT_COLORS).map(([name, color]) => `<button type="button" data-agent-choice="color" data-value="${name}" style="--agent-color:${color}" aria-label="${name}" aria-pressed="${name === draft.color}"></button>`).join("")}</div></div>
  <div><span class="agents-label">Task budget · choose explicitly</span>${choices("budget", AGENT_BUDGETS, draft.budget)}${budgetFields(draft, context)}</div>
  <div><span class="agents-label">Session permissions</span>${choices("toolPermissionMode", { ask: "Ask", full_access: "Full", full_plus: "Full+" }, draft.toolPermissionMode)}<p class="agents-hint">The existing session handles tool permissions and approval.</p></div>
  <div class="agents-settings-details">
    <details><summary>Optional guidance<span class="agents-disclosure-state" aria-hidden="true"></span></summary><label class="agents-label"><span class="sr-only">Additional guidance</span><textarea name="notes" dir="auto" spellcheck="false" maxlength="2000" rows="3" placeholder="A preference or boundary you’d like them to remember">${html(draft.notes)}</textarea></label></details>
    <details><summary>Agent instructions<span class="agents-disclosure-state" aria-hidden="true"></span></summary><pre class="agents-prompt-preview" data-agent-prompt-preview dir="ltr">${html(previewText || "")}</pre></details>
  </div>`;
}
export function budgetFields(draft, context = {}) {
  if (!draft.budget) return '<p class="agents-hint">Nothing is selected yet. Waiting never uses model calls.</p>';
  const limits = agentDraftLimits(draft);
  if (draft.budget === "custom") return `<div class="agents-limit-fields">${Object.entries(AGENT_LIMIT_FIELDS).map(([key, label]) => `<label class="agents-label">${label}<input type="number" name="limit:${key}" min="${key === "maxClarificationRounds" ? 0 : 1}" step="1" required value="${attr(draft.limits[key] ?? "")}"></label>`).join("")}</div>`;
  if (!Number.isFinite(limits.maxAttempts)) return '<p class="agents-hint">Loading budget…</p>';
  const route = { "execution-agent-v1": "EA", "supervisor-worker-v1": "SUPER" }[context.executionPolicy];
  return `<p class="agents-budget-summary">${route ? route + " · " : ""}${limits.maxAttempts} attempts · ${limits.maxModelCalls} model calls · ${limits.maxTotalTokens.toLocaleString("en-US")} tokens across all calls<br>Stop after ${limits.maxConsecutiveNoProgress} attempts without progress · ${limits.maxClarificationRounds} clarification rounds</p>`;
}
export function renderAgentOnboarding({ previewText, budgetContext, draft, step, editing, models, error, busy, id }) {
  const titles = ["What’s their focus?", "What makes their work useful?", "How should you work together?", editing ? "Make it their own." : "Meet your new agent."];
  const intros = ["Choose a starting point. You can refine it later.", "Pick the results you want and how much detail you prefer.", "A few preferences for decisions and updates.", "Give them a name, a model, and clear limits."];
  let body = "";
  if (step === 0) body = `<div class="agents-focus-grid">${Object.entries(AGENT_FOCUS).map(([key, role]) => `<button type="button" data-agent-choice="role" data-value="${key}" aria-pressed="${draft.role === key}"><strong>${role.label}</strong><span>${role.hint}</span></button>`).join("")}</div>${draft.role === "custom" ? `<label class="agents-label">Your focus<input name="custom" dir="auto" spellcheck="false" maxlength="2000" required value="${attr(draft.custom)}" placeholder="A short description is enough"></label>` : ""}`;
  if (step === 1) body = `<div><span class="agents-label">Preferred results · choose up to two</span>${choices("outputs", AGENT_OUTPUTS, draft.outputs)}</div><div><span class="agents-label">Level of detail</span>${choices("style", AGENT_STYLES, draft.style)}</div>`;
  if (step === 2) body = `<div><span class="agents-label">Ask me about</span>${choices("asks", AGENT_ASKS, draft.asks)}</div><div><span class="agents-label">Keep me updated</span>${choices("updates", AGENT_UPDATES, draft.updates)}</div>`;
  if (step === 3) body = identity(draft, models, budgetContext, previewText);
  return `<div class="agents-wizard-top"><span>${editing ? "Configure agent" : "New agent"} · ${step + 1} / 4</span><button type="button" class="agents-close" data-agents-action="close-wizard" aria-label="Close and keep draft">×</button></div><div class="agents-step-track" aria-hidden="true">${[0,1,2,3].map((index) => `<span class="${index <= step ? "done" : ""}"></span>`).join("")}</div><h1>${titles[step]}</h1><p class="agents-intro">${intros[step]}</p><form data-agents-form="onboarding"><div class="agents-wizard-fields">${body}</div><p class="agents-error" role="alert">${html(error || "")}</p>${editing && id !== "abot" ? `<div class="agents-management-actions"><button type="button" class="agents-plain" data-agents-action="archive" ${busy ? "disabled" : ""}>Archive agent</button><button type="button" class="agents-plain agents-destructive" data-agent-delete="${attr(id)}" ${busy ? "disabled" : ""}>Delete agent…</button></div><p class="agents-error" data-agent-delete-status role="status"></p>` : ""}<div class="agents-wizard-nav">${step ? '<button type="button" class="agents-plain" data-agents-action="previous-step">Back</button>' : ""}<button class="agents-primary" type="submit" ${busy ? "disabled" : ""}>${busy ? "Saving…" : step === 3 ? editing ? "Save changes" : "Add to space" : "Continue"}</button></div></form>`;
}
