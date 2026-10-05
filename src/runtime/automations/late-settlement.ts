import type { AutomationPersistence } from "./persistence.js";
import type { AutomationObservedToolSettlement } from "./tool-lifetimes.js";

/** Append evidence for effects that completed after their attempt became uncertain. */
export async function recordAutomationLateSettlements(input: {
  persistence: AutomationPersistence;
  runId: string;
  observed: readonly AutomationObservedToolSettlement[];
  now?: () => number;
}): Promise<void> {
  if (input.observed.length === 0) return;
  const now = input.now ?? Date.now;
  await input.persistence.update((state) => {
    const executionIndex = state.executions.findIndex((item) => item.id === input.runId);
    if (executionIndex < 0) throw new Error("automation_run_not_found");
    const execution = state.executions[executionIndex]!;
    const nextRevision = execution.revision + 1;
    const observedAt = new Date(now()).toISOString();
    let changed = false;
    for (const item of input.observed) {
      const attemptIndex = state.attempts.findIndex((attempt) =>
        attempt.runId === input.runId && attempt.invocationId === item.invocationId);
      if (attemptIndex < 0) continue;
      const attempt = state.attempts[attemptIndex]!;
      if (attempt.state === "settled" || attempt.lateSettlement) continue;
      const settlement = item.settlement;
      state.attempts[attemptIndex] = {
        ...attempt,
        state: "uncertain",
        lateSettlement: {
          revision: nextRevision,
          observedAt,
          status: settlement.status === "rejected"
            ? "rejected"
            : settlement.ok ? "succeeded" : "failed",
          ...(settlement.errorCode ? { errorCode: settlement.errorCode } : {}),
        },
      };
      changed = true;
    }
    if (changed) state.executions[executionIndex] = {
      ...execution,
      revision: nextRevision,
    };
  });
}
