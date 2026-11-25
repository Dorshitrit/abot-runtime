export const AGENT_BUDGETS = Object.freeze({
  short: { label: "Short" }, standard: { label: "Standard" }, deep: { label: "Deep" }, custom: { label: "Custom" },
});
export const AGENT_LIMIT_FIELDS = Object.freeze({
  maxAttempts: "Attempts", maxModelCalls: "Model calls", maxTotalTokens: "Tokens",
  maxConsecutiveNoProgress: "Attempts without progress", maxClarificationRounds: "Clarification rounds",
});

export function agentBudgetContext(definition) {
  return { role: definition?.onboarding?.role, executionPolicy: definition?.executionPolicy };
}

export function chooseAgentBudget(draft, budget, presets) {
  if (!Object.hasOwn(AGENT_BUDGETS, budget)) return;
  if (budget !== "custom") draft.limits = { ...presets[budget] };
  else if (!draft.budget) draft.limits = { ...presets.standard };
  draft.budget = budget;
  draft.budgetPresetVersion = 2;
}

// A submit is authorized only by the latest successful choice on this open form.
export function createAgentBudgetSelection(client) {
  let current = null;
  return {
    reset() { current = null; },
    async choose(draft, budget, scope, save, failed) {
      if (!Object.hasOwn(AGENT_BUDGETS, budget)) return false;
      const choice = {};
      current = choice;
      choice.result = (async () => {
        try {
          const { preview } = await client.previewAgentAuthoring({ authoring: {}, targetAgentId: scope.selected }, scope.environment);
          if (choice !== current) return false;
          chooseAgentBudget(draft, budget, preview.presets);
          await save();
          return choice === current;
        } catch (error) {
          if (choice === current) failed(error);
          return false;
        }
      })();
      return choice.result;
    },
    async settled() {
      const choice = current;
      if (choice && !await choice.result) return false;
      return current === choice;
    },
  };
}

export function agentDraftLimits(draft) {
  return Object.fromEntries(Object.keys(AGENT_LIMIT_FIELDS).map((key) => [key, Number(draft.limits?.[key])]));
}

export function invalidAgentBudget(draft) {
  if (!Object.hasOwn(AGENT_BUDGETS, draft.budget)) return true;
  return Object.keys(AGENT_LIMIT_FIELDS).some((key) => {
    const raw = draft.limits?.[key];
    if (typeof raw !== "number" && typeof raw !== "string") return true;
    if (typeof raw === "string" && !raw.trim()) return true;
    const value = Number(raw);
    return !Number.isSafeInteger(value) || value < (key === "maxClarificationRounds" ? 0 : 1);
  });
}

// Older pending forms stored a named preset but calculated its numbers only at submit time.
// A retry must carry exactly the allowance originally displayed, even if the draft also had custom inputs.
export function restoreAgentBudgetDraft(saved) {
  if (saved.budgetPresetVersion === 2 || !["short", "standard", "deep"].includes(saved.budget)) return { ...saved };
  const legacy = {
    short: [3, 12, 20_000, 2, 2], standard: [6, 32, 80_000, 2, 4], deep: [12, 80, 200_000, 3, 6],
  };
  const [maxAttempts, maxModelCalls, maxTotalTokens, maxConsecutiveNoProgress, maxClarificationRounds] = legacy[saved.budget];
  return {
    ...saved, budget: "custom", budgetPresetVersion: 2,
    limits: { maxAttempts, maxModelCalls, maxTotalTokens, maxConsecutiveNoProgress, maxClarificationRounds },
  };
}
