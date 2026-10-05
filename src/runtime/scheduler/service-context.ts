import type {
  SchedulerAutomationExecutor,
  SchedulerExecutor,
  SchedulerStore,
} from "./contracts.js";
import type { SchedulerRunCompletion } from "./run-completion.js";
import type { AutomationSchedulerRunCompletion } from "./automation-run-completion.js";
import type { SchedulerSessionDeletionState } from "./session-deletion-state.js";

export interface SchedulerContext {
  environmentId: string;
  store: SchedulerStore;
  executor: SchedulerExecutor;
  automationExecutor?: SchedulerAutomationExecutor;
  now(): number;
  running: boolean;
  generation: number;
  jobEpochs: Map<string, number>;
  pendingJobMutations: Set<string>;
  deletedSessions: SchedulerSessionDeletionState;
  pendingCompletions: Map<string, SchedulerRunCompletion>;
  pendingAutomationCompletions: Map<string, AutomationSchedulerRunCompletion>;
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  onError(error: unknown): void;
}
export function requireRunningScheduler(context: SchedulerContext): void {
  if (!context.running) throw new Error("scheduler_not_started");
}
export function jobEpoch(context: SchedulerContext, jobId: string): number {
  return context.jobEpochs.get(jobId) ?? 0;
}
export function invalidateJob(
  context: SchedulerContext,
  jobId: string,
): () => void {
  const epoch = jobEpoch(context, jobId) + 1;
  context.jobEpochs.set(jobId, epoch);
  context.pendingJobMutations.add(jobId);
  return () => {
    if (jobEpoch(context, jobId) !== epoch) return;
    context.pendingJobMutations.delete(jobId);
  };
}
export function canBeginSchedulerRun(
  context: SchedulerContext,
  jobId: string,
  epoch: number,
): boolean {
  if (!context.running) return false;
  if (context.pendingJobMutations.has(jobId)) return false;
  return jobEpoch(context, jobId) === epoch;
}

export function canBeginRequestSchedulerRun(
  context: SchedulerContext,
  jobId: string,
  sessionId: string,
  epoch: number,
): boolean {
  if (context.deletedSessions.has(sessionId)) return false;
  return canBeginSchedulerRun(context, jobId, epoch);
}
