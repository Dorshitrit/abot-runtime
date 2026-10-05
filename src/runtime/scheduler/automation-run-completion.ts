import type {
  SchedulerAutomationRun,
  SchedulerAutomationRunOutcome,
  SchedulerAutomationStartedRun,
  SchedulerStoredRun,
} from "./contracts.js";
import { isAutomationSchedulerRun } from "./scheduler-target.js";
import type { SchedulerContext } from "./service-context.js";

export interface AutomationSchedulerRunCompletion {
  runId: string;
  automationId: string;
  generation: number;
  outcome: SchedulerAutomationRunOutcome;
  finishedAt: string;
}

export async function settleAutomationSchedulerRun(
  context: SchedulerContext,
  run: SchedulerAutomationRun,
  generation: number,
  execution: SchedulerAutomationStartedRun,
  release: () => void,
): Promise<void> {
  const resourcesSettled = execution.resourcesSettled.catch((error: unknown) => {
    try {
      context.onError(error);
    } catch {
      // A diagnostic callback cannot release admission before effects settle.
    }
  });
  try {
    const outcome = await execution.outcome.catch(
      (error: unknown): SchedulerAutomationRunOutcome => ({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const completion: AutomationSchedulerRunCompletion = {
      runId: run.id,
      automationId: run.target.automationId,
      generation,
      outcome,
      finishedAt: new Date(context.now()).toISOString(),
    };
    await context.enqueue(async () => {
      if (!canPersistAutomationCompletion(context, completion)) return;
      context.pendingAutomationCompletions.set(run.id, completion);
      await persistAutomationCompletion(context, completion);
    });
  } catch (error) {
    context.onError(error);
  } finally {
    try {
      await resourcesSettled;
    } finally {
      release();
    }
  }
}

export async function reconcileAutomationSchedulerCompletions(
  context: SchedulerContext,
): Promise<void> {
  for (const completion of context.pendingAutomationCompletions.values()) {
    await persistAutomationCompletion(context, completion);
  }
}

async function persistAutomationCompletion(
  context: SchedulerContext,
  completion: AutomationSchedulerRunCompletion,
): Promise<void> {
  if (!canPersistAutomationCompletion(context, completion)) {
    context.pendingAutomationCompletions.delete(completion.runId);
    return;
  }
  const update = context.store.updateWithAutomations;
  if (!update) throw new Error("automation_store_unavailable");
  try {
    await update((scheduler, automations) => {
      if (!canPersistAutomationCompletion(context, completion)) return;
      const run = scheduler.runs.find((item) => item.id === completion.runId);
      if (!isUnsettledAutomationRun(run, completion)) return;
      if (!context.automationExecutor)
        throw new Error("automation_executor_unavailable");
      context.automationExecutor.settle(run, automations, completion.outcome);
      const execution = automations.executions.find(
        (item) => item.id === run.id,
      );
      const reportRef = completion.outcome.reportRef ?? execution?.reportRef;
      if (!reportRef) throw new Error("automation_report_missing");
      run.status = completion.outcome.status;
      run.finishedAt = completion.finishedAt;
      run.reportRef = reportRef;
      if (completion.outcome.error) run.error = completion.outcome.error;
    });
    context.pendingAutomationCompletions.delete(completion.runId);
  } catch (error) {
    // Only retry the terminal commit; never re-execute its effect.
    context.onError(error);
  }
}

function canPersistAutomationCompletion(
  context: SchedulerContext,
  completion: AutomationSchedulerRunCompletion,
): boolean {
  if (!context.running) return false;
  return context.generation === completion.generation;
}

function isUnsettledAutomationRun(
  run: SchedulerStoredRun | undefined,
  completion: AutomationSchedulerRunCompletion,
): run is SchedulerAutomationRun {
  if (!run || !isAutomationSchedulerRun(run)) return false;
  if (run.target.automationId !== completion.automationId) return false;
  return run.status === "running" || run.status === "stopping";
}
