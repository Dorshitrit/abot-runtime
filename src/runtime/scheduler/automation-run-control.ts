import type {
  AutomationExecutionRecord,
} from "../automations/storage-records.js";
import type { SchedulerAutomationRun } from "./contracts.js";
import { requireCommittedAutomationExecution } from "./automation-job-management.js";
import { requireRunningScheduler, type SchedulerContext } from "./service-context.js";
import { isAutomationSchedulerRun } from "./scheduler-target.js";

export function stopAutomationSchedulerRun(
  context: SchedulerContext,
  runId: string,
): Promise<SchedulerAutomationRun> {
  return context.enqueue(async () => {
    requireRunningScheduler(context);
    const update = context.store.updateWithAutomations;
    const executor = context.automationExecutor;
    if (!update || !executor) throw new Error("automation_executor_unavailable");
    let signalStop = false;
    const run = await update((scheduler, automations) => {
      const candidate = scheduler.runs.find((item) => item.id === runId);
      if (!candidate || !isAutomationSchedulerRun(candidate))
        throw new Error("automation_run_not_found");
      if (candidate.status === "pending") {
        executor.cancelPending(candidate, automations, "stopped");
        const execution = requireCommittedAutomationExecution(automations, runId);
        if (!execution.reportRef) throw new Error("automation_report_missing");
        candidate.status = "cancelled";
        candidate.reportRef = execution.reportRef;
        candidate.finishedAt = new Date(context.now()).toISOString();
        return candidate;
      }
      if (candidate.status === "running") {
        const at = new Date(context.now()).toISOString();
        const execution = requireCommittedAutomationExecution(automations, runId);
        replaceExecution(
          automations.executions,
          execution,
          { ...execution, revision: execution.revision + 1, stopRequestedAt: at },
        );
        candidate.status = "stopping";
        signalStop = true;
        return candidate;
      }
      if (candidate.status === "stopping") signalStop = true;
      return candidate;
    });
    if (signalStop) executor.stop(runId);
    return run;
  });
}

function replaceExecution(
  executions: AutomationExecutionRecord[],
  existing: AutomationExecutionRecord,
  updated: AutomationExecutionRecord,
): void {
  const index = executions.findIndex((item) => item.id === existing.id);
  if (index < 0) throw new Error("automation_execution_checkpoint_missing");
  executions[index] = updated;
}
