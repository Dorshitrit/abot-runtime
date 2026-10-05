import type { AutomationPersistence } from "./persistence.js";
import type { AutomationDraftRecord, AutomationJournalState } from "./storage-records.js";
import { hasActiveAutomationRun } from "../scheduler/automation-run-records.js";
import { isAutomationSchedulerJob } from "../scheduler/scheduler-target.js";

export function requireUnarchivedAutomation(
  state: AutomationJournalState,
  automationId: string,
): void {
  if (state.drafts.some((draft) =>
    draft.automationId === automationId && draft.archivedAt !== undefined))
    throw new Error("automation_archived");
}

export function createAutomationArchiveManager(options: {
  persistence: AutomationPersistence;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  async function changeArchiveState(
    automationId: string,
    expectedRevision: number,
    archived: boolean,
  ): Promise<AutomationDraftRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error("automation_revision_conflict");
    return options.persistence.updateWithScheduler((scheduler, state) => {
      const index = state.drafts.findIndex((draft) => draft.automationId === automationId);
      const draft = state.drafts[index];
      if (!draft) throw new Error("automation_not_found");
      if (draft.revision !== expectedRevision)
        throw new Error("automation_revision_conflict");
      const job = scheduler.jobs.find((candidate) =>
        isAutomationSchedulerJob(candidate) &&
        candidate.target.automationId === automationId);
      const published = state.definitions.some((definition) =>
        definition.automationId === automationId);
      if (!job || !published) throw new Error("automation_not_published");
      if (hasActiveAutomationRun(scheduler, automationId))
        throw new Error("automation_run_active");
      if ((draft.archivedAt !== undefined) === archived) return draft;
      const at = new Date(now()).toISOString();
      // Content revisions and published execution definitions remain unchanged.
      const next = {
        ...draft, updatedAt: at,
        storageRevision: (draft.storageRevision ?? draft.revision) + 1,
      };
      if (archived) next.archivedAt = at;
      else delete next.archivedAt;
      job.state = "paused";
      job.nextRunAt = null;
      job.updatedAt = at;
      job.revision += 1;
      state.drafts[index] = next;
      return next;
    });
  }

  return {
    archive: (automationId: string, expectedRevision: number) =>
      changeArchiveState(automationId, expectedRevision, true),
    restore: (automationId: string, expectedRevision: number) =>
      changeArchiveState(automationId, expectedRevision, false),
  };
}
