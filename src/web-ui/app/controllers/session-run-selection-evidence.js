import { isReasoningPreference } from "../lib/reasoning-preference.js";

const modes = new Set(["auto", "fast", "reasoning", "deep"]);
const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const sources = new Set(["invocation", "request", "configuration", "agent-mode"]);

function recordedBudget(value) {
  if (value?.mode === "server-default") return { mode: "server-default" };
  if (value?.mode !== "tokens") return undefined;
  if (!Number.isSafeInteger(value.tokens) || value.tokens < 0) return undefined;
  return { mode: "tokens", tokens: value.tokens };
}

export function recordedRunReasoning(value) {
  if (typeof value?.profileId !== "string" || typeof value.modelStep !== "string") return undefined;
  const budget = recordedBudget(value.reasoningBudget);
  return {
    profileId: value.profileId, modelStep: value.modelStep,
    ...(efforts.has(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
    ...(budget ? { reasoningBudget: budget } : {}),
    ...(sources.has(value.reasoningControlSource) ? { reasoningControlSource: value.reasoningControlSource } : {}),
  };
}

/** Retain only the bounded presentation contract, never arbitrary event diagnostics. */
export function normalizedRunSelection(value) {
  if (!value || typeof value.requestId !== "string" || !value.requestId) return null;
  if (!Number.isFinite(value.selectedAt)) return null;
  const run = { requestId: value.requestId, selectedAt: value.selectedAt };
  for (const key of ["primaryProfileId", "generation", "status"]) {
    if (typeof value[key] === "string") run[key] = value[key];
  }
  if (modes.has(value.agentMode)) run.agentMode = value.agentMode;
  if (isReasoningPreference(value.reasoningPreference) && value.reasoningPreference.profileId === run.primaryProfileId)
    run.reasoningPreference = { ...value.reasoningPreference };
  run.rootModelSteps = Array.isArray(value.rootModelSteps) ? value.rootModelSteps.filter((step) => typeof step === "string") : [];
  const model = value.primaryModel;
  if (model && ["label", "provider", "model"].every((key) => typeof model[key] === "string"))
    run.primaryModel = { label: model.label, provider: model.provider, model: model.model };
  const effective = recordedRunReasoning(value.effectiveReasoning);
  if (effective?.profileId === run.primaryProfileId) run.effectiveReasoning = effective;
  if (Number.isSafeInteger(value.reasoningEventSequence) && value.reasoningEventSequence > 0)
    run.reasoningEventSequence = value.reasoningEventSequence;
  return run;
}

function sameFields(left, right, keys) {
  return keys.every((key) => left?.[key] === right?.[key]);
}

export function sameRunReasoning(left, right) {
  if (Boolean(left) !== Boolean(right)) return false;
  if (!sameFields(left, right, ["profileId", "modelStep", "reasoningEffort", "reasoningControlSource"])) return false;
  return sameFields(left?.reasoningBudget, right?.reasoningBudget, ["mode", "tokens"]);
}

/** Ordering and root-step binding still update when the visible controls are equal. */
export function sameRunSelectionPresentation(left, right) {
  if (Boolean(left) !== Boolean(right)) return false;
  if (!sameFields(left, right, ["requestId", "generation", "status", "primaryProfileId", "agentMode"])) return false;
  if (!sameFields(left?.primaryModel, right?.primaryModel, ["label", "provider", "model"])) return false;
  if (!sameFields(left?.reasoningPreference, right?.reasoningPreference, ["profileId", "mode", "budgetTokens"])) return false;
  return sameRunReasoning(left?.effectiveReasoning, right?.effectiveReasoning);
}
