import { requireUnarchivedAutomation } from "./archive-management.js";
import { parseAutomationDefinition } from "./definition-input.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationDraftRecord } from "./storage-records.js";
import { isAutomationSchedulerJob } from "../scheduler/scheduler-target.js";

/** Publication restoration is a persisted command, not a pure graph mutation. */
export function readPublishedDraftRestoration(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.kind !== "restore_published") return null;
  const keys = Object.keys(input);
  const validKeys = keys.length === 2 && keys.every((key) => ["kind", "publishedRevision"].includes(key));
  if (!validKeys || !Number.isSafeInteger(input.publishedRevision) || Number(input.publishedRevision) < 1)
    throw new Error("automation_graph_invalid");
  return Number(input.publishedRevision);
}

export function restorePublishedAutomationDraft(options: {
  persistence: AutomationPersistence;
  automationId: string;
  expectedRevision: number;
  publishedRevision: number;
  now: () => number;
}): Promise<AutomationDraftRecord> {
  return options.persistence.updateWithScheduler((scheduler, state) => {
    const index = state.drafts.findIndex((draft) => draft.automationId === options.automationId);
    const current = state.drafts[index];
    if (!current) throw new Error("automation_not_found");
    requireUnarchivedAutomation(state, options.automationId);
    if (current.revision !== options.expectedRevision) throw new Error("automation_revision_conflict");
    const job = scheduler.jobs.find((candidate) => isAutomationSchedulerJob(candidate) &&
      candidate.target.automationId === options.automationId);
    if (!job || !isAutomationSchedulerJob(job)) throw new Error("automation_not_published");
    if (job.target.definitionRevision !== options.publishedRevision)
      throw new Error("automation_revision_conflict");
    const published = state.definitions.find((definition) =>
      definition.automationId === options.automationId && definition.revision === options.publishedRevision);
    if (!published) throw new Error("automation_not_published");
    const definition = parseAutomationDefinition({ ...published.definition, revision: current.revision + 1 });
    const restored: AutomationDraftRecord = {
      ...current, definition, revision: definition.revision,
      storageRevision: (current.storageRevision ?? current.revision) + 1,
      updatedAt: new Date(options.now()).toISOString(),
    };
    state.drafts[index] = restored;
    return restored;
  });
}
