function recordedEffortLabel(effective) {
  if (effective.reasoningEffort === "none") return "Off";
  if (effective.reasoningBudget?.mode === "tokens" && effective.reasoningBudget.tokens === 0) return "Off";
  const effort = effective.reasoningEffort;
  if (typeof effort !== "string" || !effort) return "Provider default";
  return effort[0].toUpperCase() + effort.slice(1);
}

function recordedBudgetLabel(budget) {
  if (budget?.mode === "tokens") return `${budget.tokens} tokens`;
  if (budget?.mode === "server-default") return "Server default";
  return undefined;
}

/** Provider evidence is displayed directly; request modes are not provider effort. */
export function sessionRunReasoningDisplay(run) {
  if (!run) return null;
  const effective = run.effectiveReasoning;
  if (!effective) return { label: "Unknown", icon: "?", title: "Run reasoning has not been recorded" };
  const label = recordedEffortLabel(effective);
  const detail = `Run reasoning: ${label}; ${effective.modelStep}`;
  const budgetLabel = recordedBudgetLabel(effective.reasoningBudget);
  return { label, icon: label === "Off" ? "—" : "R", title: detail, budgetLabel, budgetTitle: budgetLabel ? `Run thinking budget: ${budgetLabel}` : undefined };
}
