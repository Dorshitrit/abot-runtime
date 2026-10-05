import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import { requireUnarchivedAutomation } from "./archive-management.js";
import type { SchedulerService } from "../scheduler/contracts.js";
import { readAutomationCatalog } from "./catalog.js";
import type { AutomationDraftManager } from "./draft-management.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationGrantManager } from "./permission-grants.js";
import { currentAutomationGrant } from "./permission-grants.js";
import { validateAutomationPublication } from "./publication-validation.js";
import { fingerprintAutomationDependencies } from "./dependency-fingerprint.js";
import type { AutomationDefinitionRecord, AutomationJournalState } from "./storage-records.js";
import type { AutomationGraphIssue } from "./graph-validation.js";
import { automationTriggerSchedule, publishedAutomationScheduleTiming } from "./trigger-schedule.js";

export class AutomationPublicationError extends Error {
  constructor(readonly issues: readonly AutomationGraphIssue[]) {
    super("automation_graph_invalid");
  }
}

function commitDefinition(
  state: AutomationJournalState,
  automationId: string,
  expectedRevision: number,
  record: AutomationDefinitionRecord,
): void {
  requireUnarchivedAutomation(state, automationId);
  const current = state.drafts.find((item) => item.automationId === automationId);
  if (!current || current.revision !== expectedRevision)
    throw new Error("automation_revision_conflict");
  if (state.definitions.some((item) =>
    item.automationId === automationId && item.revision === expectedRevision))
    throw new Error("automation_already_published");
  state.definitions.push(record);
}

function requirePublicationGrantRevision(
  state: AutomationJournalState, environmentId: string, automationId: string,
  expectedGrantRevision: number | null,
): void {
  const latest = currentAutomationGrant(state.grants, environmentId, automationId);
  if ((latest?.grantRevision ?? null) !== expectedGrantRevision)
    throw new Error("automation_grant_revision_conflict");
}

export function createAutomationPublicationService(options: {
  config: RuntimeConfig;
  drafts: AutomationDraftManager;
  grants: AutomationGrantManager;
  persistence: AutomationPersistence;
  scheduler: SchedulerService;
  tools: ToolRegistry;
  timeZone: string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  async function publish(automationId: string, expectedRevision: number) {
    const draft = await options.drafts.get(automationId);
    if (!draft || draft.revision !== expectedRevision)
      throw new Error("automation_revision_conflict");
    if (draft.archivedAt) throw new Error("automation_archived");
    const grant = await options.grants.get(automationId);
    const catalog = await readAutomationCatalog({
      automationId,
      environmentId: options.config.runtimeId,
      config: options.config,
      tools: options.tools,
      persistence: options.persistence,
    });
    const job = await options.scheduler.getAutomationJob(automationId);
    const state = await options.persistence.read();
    const issues = validateAutomationPublication({
      definition: draft.definition,
      config: options.config,
      operations: catalog.operations,
      grantMode: grant?.mode ?? "full_access",
      now: now(),
      timeZone: options.timeZone,
      existingSchedule: publishedAutomationScheduleTiming(state, job, draft.definition.trigger),
    });
    if (issues.length > 0) throw new AutomationPublicationError(issues);
    const record: AutomationDefinitionRecord = {
      id: `definition:${automationId}:${draft.revision}`,
      automationId,
      revision: draft.revision,
      definition: structuredClone(draft.definition),
      publishedAt: new Date(now()).toISOString(),
      dependencyFingerprint: fingerprintAutomationDependencies({
        definition: draft.definition,
        config: options.config,
        operations: catalog.operations,
      }),
    };
    const schedule = automationTriggerSchedule(record.definition.trigger);
    const commit = (state: AutomationJournalState, candidate: { id: string; revision: number }) => {
      requirePublicationGrantRevision(state, options.config.runtimeId, automationId,
        grant?.grantRevision ?? null);
      commitDefinition(state, automationId, expectedRevision, record);
      // This callback mutates only the transaction candidate; a conflict
      // rejects both the definition and job before either is published.
      const publicationJobChanged = job &&
        (candidate.id !== job.id || candidate.revision !== job.revision + 1);
      if (publicationJobChanged) throw new Error("automation_revision_conflict");
    };
    const publishedJob = job
      ? await options.scheduler.updateAutomationJob(job.id, {
          definitionRevision: record.revision,
          title: record.definition.title,
          schedule,
          timeZone: options.timeZone,
        }, commit)
      : await options.scheduler.createAutomationJob({
          automationId,
          definitionRevision: record.revision,
          title: record.definition.title,
          schedule,
          timeZone: options.timeZone,
        }, commit);
    return { definition: record, job: publishedJob };
  }

  return { publish };
}

export type AutomationPublicationService = ReturnType<typeof createAutomationPublicationService>;
