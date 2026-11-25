import { AGENT_BUDGETS, agentDraftLimits, invalidAgentBudget } from "./agent-budgets.js";
export { AGENT_BUDGETS, AGENT_LIMIT_FIELDS, agentDraftLimits } from "./agent-budgets.js";
export const AGENT_COLORS = Object.freeze({ blue: "#7aaee7", sand: "#dcb37b", mint: "#7dc1aa", lilac: "#ae98cd", ivory: "#d3d9cd" });
export const AGENT_FOCUS = Object.freeze({
  research: { label: "Research & explain", hint: "Find, compare, make sense", name: "Scout" },
  writing: { label: "Write & edit", hint: "Find the right words", name: "Quill" },
  coding: { label: "Build & troubleshoot", hint: "Code, debug, improve", name: "Patch" },
  planning: { label: "Plan & organize", hint: "Turn ideas into next steps", name: "Atlas" },
  everyday: { label: "Everyday help", hint: "A flexible thinking partner", name: "Nova" },
  custom: { label: "Something else", hint: "Give it your own focus", name: "Echo" },
});
export const AGENT_OUTPUTS = Object.freeze({ recommendations: "Clear recommendations", summaries: "Concise summaries", comparisons: "Side-by-side comparisons", drafts: "Ready-to-use drafts", plans: "Actionable plans", code: "Working code" });
export const AGENT_STYLES = Object.freeze({ concise: { label: "Concise" }, balanced: { label: "Balanced" }, detailed: { label: "Detailed" } });
export const AGENT_ASKS = Object.freeze({ unclear: "An unclear goal", tradeoffs: "Meaningful tradeoffs", direction: "A change of direction" });
export const AGENT_UPDATES = Object.freeze({ needed: { label: "When I’m needed" }, milestones: { label: "Key milestones" }, brief: { label: "Brief progress updates" } });
export function emptyAgentDraft() {
  return { role: "", outputs: [], style: "balanced", asks: ["unclear", "tradeoffs"], updates: "needed", custom: "", notes: "", name: "", modelProfileId: "", color: "blue", budget: "", limits: {}, toolPermissionMode: "ask" };
}
export function validateAgentDraft(draft, step, models = []) {
  if (step === 0 && !AGENT_FOCUS[draft.role]) return "Choose a focus to get started.";
  if (step === 0 && draft.role === "custom" && !draft.custom.trim()) return "Add a short description of their focus.";
  if (step === 1 && !draft.outputs.length) return "Choose at least one preferred result.";
  if (step !== 3) return "";
  if (!draft.name.trim()) return "Give your agent a name.";
  if (!models.some((model) => model.id === draft.modelProfileId)) return "Choose an available model.";
  if (!Object.hasOwn(AGENT_BUDGETS, draft.budget)) return "Choose a task budget. No work starts without your choice.";
  if (invalidAgentBudget(draft)) return "Enter whole numbers for all five task limits.";
  return "";
}
export function agentDraftAuthoring(draft) {
  const onboarding = Object.fromEntries(["role", "outputs", "style", "asks", "updates", "custom", "notes", "color", "budget"].map(key => [key, draft[key]]));
  return { name: draft.name, icon: `pebbles-${draft.color}`, modelProfileId: draft.modelProfileId, toolPermissionMode: draft.toolPermissionMode,
    onboarding, ...(draft.budget === "custom" && !invalidAgentBudget(draft) ? { limits: agentDraftLimits(draft) } : {}) };
}
export function agentDraftFromDetail(detail) {
  const definition = detail.agent.definition;
  const draft = { ...emptyAgentDraft(), ...(definition.onboarding || detail.onboarding || detail.settings?.onboarding || {}), name: definition.name, modelProfileId: definition.modelProfileId, toolPermissionMode: definition.toolPermissionMode };
  draft.color = Object.hasOwn(AGENT_COLORS, String(definition.icon).replace("pebbles-", "")) ? definition.icon.replace("pebbles-", "") : "mint";
  if (!draft.role) { draft.role = "custom"; draft.custom = definition.basePrompt; }
  if (!draft.outputs.length) draft.outputs = ["recommendations"];
  const limits = detail.limits ?? definition.defaultLimits ?? detail.settings?.limits;
  if (limits) {
    draft.budget = draft.budget || "custom";
    draft.limits = { ...limits };
    draft.budgetPresetVersion = 2;
  }
  return draft;
}

// A saved raw prompt may exceed the onboarding focus field. An identity or budget edit
// can still submit the existing raw definition without storing the prompt as a focus.
export function unchangedLongManualPrompt(initial, draft, definition) {
  if (!initial || definition?.onboarding || !(definition?.basePrompt.length > 2000)) return null;
  if (draft.role !== "custom" || draft.custom !== definition.basePrompt) return null;
  const preferences = ["outputs", "asks", "style", "updates", "notes"];
  if (preferences.some(key => JSON.stringify(initial[key]) !== JSON.stringify(draft[key]))) return null;
  return definition.basePrompt;
}
