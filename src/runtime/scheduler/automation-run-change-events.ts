import type { AutomationJournalState } from "../automations/storage-records.js";
import type {
  SchedulerAutomationRun,
  SchedulerSnapshot,
  SchedulerStore,
} from "./contracts.js";
import { isAutomationSchedulerRun } from "./scheduler-target.js";

export type AutomationRunChange = Readonly<{
  phase: "started" | "finished";
  environmentId: string;
  automationId: string;
  runId: string;
  title: string;
  status: SchedulerAutomationRun["status"];
}>;

function isTerminalAutomationRun(status: SchedulerAutomationRun["status"]): boolean {
  return ["succeeded", "completed_with_skips", "failed", "cancelled", "interrupted", "missed"]
    .includes(status);
}

function automationRunChangePhase(status: SchedulerAutomationRun["status"]):
  AutomationRunChange["phase"] | null {
  if (status === "running") return "started";
  if (isTerminalAutomationRun(status)) return "finished";
  return null;
}

function automationRunStatuses(state: SchedulerSnapshot): Map<string, SchedulerAutomationRun["status"]> {
  return new Map(state.runs.filter(isAutomationSchedulerRun)
    .map((run) => [run.id, run.status]));
}

function changedAutomationRuns(
  previous: ReadonlyMap<string, SchedulerAutomationRun["status"]>,
  state: SchedulerSnapshot,
): AutomationRunChange[] {
  const changes: AutomationRunChange[] = [];
  for (const run of state.runs) {
    if (!isAutomationSchedulerRun(run)) continue;
    if (previous.get(run.id) === run.status) continue;
    const phase = automationRunChangePhase(run.status);
    if (!phase) continue;
    changes.push({
      phase,
      environmentId: run.environmentId,
      automationId: run.target.automationId,
      runId: run.id,
      title: run.title,
      status: run.status,
    });
  }
  return changes;
}

/** Publish only transitions whose scheduler transaction committed successfully. */
export function observeAutomationRunChanges(
  store: SchedulerStore,
  onChange: (change: AutomationRunChange) => void,
): SchedulerStore {
  function publish(changes: readonly AutomationRunChange[]): void {
    for (const change of changes) {
      try {
        onChange(change);
      } catch {
        // A notification observer cannot change the result of a durable commit.
      }
    }
  }

  return {
    ...store,
    async update<T>(mutate: (state: SchedulerSnapshot) => T, view?: "active"): Promise<T> {
      let changes: AutomationRunChange[] = [];
      const result = await store.update((state) => {
        const previous = automationRunStatuses(state);
        const value = mutate(state);
        changes = changedAutomationRuns(previous, state);
        return value;
      }, view);
      publish(changes);
      return result;
    },
    ...(store.updateWithAutomations ? {
      async updateWithAutomations<T>(
        mutate: (scheduler: SchedulerSnapshot, automations: AutomationJournalState) => T,
        view?: "active",
      ): Promise<T> {
        let changes: AutomationRunChange[] = [];
        const result = await store.updateWithAutomations!((scheduler, automations) => {
          const previous = automationRunStatuses(scheduler);
          const value = mutate(scheduler, automations);
          changes = changedAutomationRuns(previous, scheduler);
          return value;
        }, view);
        publish(changes);
        return result;
      },
    } : {}),
  };
}
