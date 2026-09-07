import type { SchedulerRun, SchedulerRunOutcome } from "./contracts.js";
import type { SchedulerContext } from "./service-context.js";

export interface SchedulerRunCompletion {
  runId: string;
  sessionId: string;
  requestId: string;
  generation: number;
  outcome: SchedulerRunOutcome;
  finishedAt: string;
}

export async function settleSchedulerRun(
  context: SchedulerContext,
  run: SchedulerRun,
  generation: number,
  execution: Promise<SchedulerRunOutcome>,
  release: () => void,
): Promise<void> {
  const identity = {
    runId: run.id,
    sessionId: run.sessionId,
    requestId: run.requestId,
  };
  try {
    const outcome = await execution.catch(
      (error: unknown): SchedulerRunOutcome => ({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    const completion: SchedulerRunCompletion = {
      ...identity,
      generation,
      outcome: { ...outcome },
      finishedAt: new Date(context.now()).toISOString(),
    };
    await context.enqueue(async () => {
      if (!canPersistCompletion(context, completion)) return;
      context.pendingCompletions.set(completion.runId, completion);
      await persistCompletion(context, completion);
    });
  } catch (error) {
    context.onError(error);
  } finally {
    release();
  }
}

export async function reconcileSchedulerCompletions(
  context: SchedulerContext,
): Promise<void> {
  // Each ordinary tick attempts retained writes once, without executing work.
  for (const completion of context.pendingCompletions.values()) {
    await persistCompletion(context, completion);
  }
}

async function persistCompletion(
  context: SchedulerContext,
  completion: SchedulerRunCompletion,
): Promise<void> {
  if (!canPersistCompletion(context, completion)) {
    context.pendingCompletions.delete(completion.runId);
    return;
  }
  try {
    await context.store.update((state) => {
      // Stop and session deletion can arrive while the store awaits its read.
      if (!canPersistCompletion(context, completion)) return;
      const run = state.runs.find(
        (candidate) => candidate.id === completion.runId,
      );
      if (!isUnsettledCapturedRun(run, completion)) return;
      Object.assign(run, completion.outcome, {
        finishedAt: completion.finishedAt,
      });
    });
    context.pendingCompletions.delete(completion.runId);
  } catch (error) {
    // Keep the captured outcome for a later clock tick, not an execution retry.
    context.onError(error);
  }
}

function canPersistCompletion(
  context: SchedulerContext,
  completion: SchedulerRunCompletion,
): boolean {
  if (!context.running) return false;
  if (context.generation !== completion.generation) return false;
  return !context.deletedSessions.has(completion.sessionId);
}

function isUnsettledCapturedRun(
  run: SchedulerRun | undefined,
  completion: SchedulerRunCompletion,
): run is SchedulerRun {
  if (!run) return false;
  if (run.status !== "running") return false;
  if (run.sessionId !== completion.sessionId) return false;
  return run.requestId === completion.requestId;
}
