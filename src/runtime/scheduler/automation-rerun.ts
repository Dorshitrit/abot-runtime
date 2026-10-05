import { randomUUID } from "node:crypto";
import { requireUnarchivedAutomation } from "../automations/archive-management.js";
import type {
  SchedulerAutomationJob,
  SchedulerAutomationRun,
} from "./contracts.js";
import { requireCommittedAutomationExecution } from "./automation-job-management.js";
import { hasReachedAutomationDailyRunLimit } from "./automation-run-budget.js";
import {
  hasActiveAutomationRun,
  makeAutomationSchedulerRun,
  requireAutomationSchedulerJob,
} from "./automation-run-records.js";
import {
  canBeginSchedulerRun,
  jobEpoch,
  requireRunningScheduler,
  type SchedulerContext,
} from "./service-context.js";
import { isAutomationSchedulerRun } from "./scheduler-target.js";
import type { SchedulerService } from "./contracts.js";

type RerunOptions = Parameters<SchedulerService["rerunAutomationRun"]>[1];

function requireReplayableRun(
  run: Awaited<ReturnType<NonNullable<SchedulerContext["store"]["readRun"]>>>,
): SchedulerAutomationRun {
  if (!run || !isAutomationSchedulerRun(run))
    throw new Error("automation_run_not_found");
  if (["pending", "running", "stopping"].includes(run.status))
    throw new Error("automation_run_active");
  if (!run.reportRef) throw new Error("automation_report_missing");
  return run;
}

function replayJob(
  current: SchedulerAutomationJob,
  previous: SchedulerAutomationRun,
): SchedulerAutomationJob {
  return {
    ...current,
    target: { ...current.target, definitionRevision: previous.target.definitionRevision },
  };
}

export function requestAutomationSchedulerRerun(
  context: SchedulerContext,
  previousRunId: string,
  options: RerunOptions,
): Promise<SchedulerAutomationRun> {
  return context.enqueue(async () => {
    requireRunningScheduler(context);
    if (options?.confirmed !== true ||
        typeof options.idempotencyKey !== "string" ||
        !options.idempotencyKey || options.idempotencyKey.length > 128 ||
        typeof options.validateAdmission !== "function")
      throw new Error("automation_rerun_confirmation_required");
    const readRun = context.store.readRun;
    const readByKey = context.store.readAutomationRunByKey;
    const update = context.store.updateWithAutomations;
    const executor = context.automationExecutor;
    if (!readRun || !readByKey || !update || !executor?.prepareReplay)
      throw new Error("automation_rerun_unavailable");
    const previous = requireReplayableRun(await readRun(previousRunId));
    const scheduler = await context.store.read();
    const job = requireAutomationSchedulerJob(scheduler, previous.jobId);
    if (job.state === "cancelled" ||
        job.target.automationId !== previous.target.automationId)
      throw new Error("automation_job_not_found");
    if (!context.store.readAutomations) throw new Error("automation_store_unavailable");
    requireUnarchivedAutomation(await context.store.readAutomations(), job.target.automationId);
    const existing = await readByKey(previous.target.automationId, options.idempotencyKey);
    if (existing) {
      if (existing.replayOf !== previous.id || existing.jobId !== job.id)
        throw new Error("automation_idempotency_conflict");
      return existing;
    }
    if (hasActiveAutomationRun(scheduler, job.target.automationId))
      throw new Error("automation_run_active");
    await options.preflight?.(job, previous);
    if (await hasReachedAutomationDailyRunLimit(context, job, context.now()))
      throw new Error("automation_budget_exhausted");
    const candidateRunId = randomUUID();
    const epoch = jobEpoch(context, job.id);
    const prepared = await executor.prepareReplay(
      replayJob(job, previous), previous, candidateRunId,
    );
    if (prepared.kind !== "ready") throw new Error("automation_replay_input_unavailable");
    let claimed = false;
    try {
      const run = await update((current, automations) => {
        if (!canBeginSchedulerRun(context, job.id, epoch))
          throw new Error("automation_job_changed");
        const live = requireAutomationSchedulerJob(current, job.id);
        requireUnarchivedAutomation(automations, live.target.automationId);
        if (live.revision !== job.revision)
          throw new Error("automation_job_changed");
        if (hasActiveAutomationRun(current, live.target.automationId))
          throw new Error("automation_run_active");
        options.validateAdmission(automations, live, previous);
        const run = {
          ...makeAutomationSchedulerRun(
            replayJob(live, previous), candidateRunId,
            new Date(context.now()).toISOString(), "manual", options.idempotencyKey,
          ),
          replayOf: previous.id,
        };
        prepared.commit(automations, run.id);
        const execution = requireCommittedAutomationExecution(automations, run.id);
        if (execution.definitionRevision !== previous.target.definitionRevision ||
            execution.inputIds.length !== prepared.inputIds.length ||
            execution.inputIds.some((id, index) => id !== prepared.inputIds[index]))
          throw new Error("automation_execution_checkpoint_mismatch");
        current.runs.push(run);
        return run;
      });
      claimed = true;
      return run;
    } finally {
      if (!claimed) await prepared.discard?.();
    }
  });
}
