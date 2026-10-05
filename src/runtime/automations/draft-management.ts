import { randomUUID } from "node:crypto";
import { requireUnarchivedAutomation } from "./archive-management.js";
import type { SchedulerSnapshot } from "../scheduler/contracts.js";
import type { AutomationRevision } from "./definition-contracts.js";
import type { AutomationDraftRecord, AutomationJournalState } from "./storage-records.js";
import type { AutomationPersistence } from "./persistence.js";
import { createEmptyAutomationDefinition, applyDraftMutation, parseDraftMutation } from "./draft-mutations.js";
import { compileAutomationGraph } from "./graph-validation.js";
import { applyAutomationDraftBatch, parseAutomationDraftBatch } from "./draft-batch.js";
import { readPublishedDraftRestoration, restorePublishedAutomationDraft } from "./draft-restoration.js";

export type AutomationDraftSummary = Readonly<{
  id: string;
  title: string;
  draftRevision: number;
  updatedAt: string;
  publishedRevision?: number;
  status: "draft" | "paused" | "active" | "archived";
}>;

export type AutomationDraftPlanResult = Readonly<{
  draft: AutomationDraftRecord;
  aliases: Readonly<Record<string, string>>;
}>;

/** Owner-local synchronous admission only; remote service calls omit this callback. */
export type AutomationDraftPlanAcceptance = (result: AutomationDraftPlanResult) => true;

function isSupportedDraftPlanAcceptance(value: unknown): value is AutomationDraftPlanAcceptance | undefined {
  if (value === undefined) return true;
  return typeof value === "function";
}

function requireDraftPlanAcceptance(result: AutomationDraftPlanResult, accept?: AutomationDraftPlanAcceptance): void {
  if (accept === undefined) return;
  if (accept(result) !== true) throw new Error("automation_draft_plan_acceptance_invalid");
}

function draftStatus(
  draft: AutomationDraftRecord,
  publishedRevision: number,
): AutomationDraftSummary["status"] {
  if (draft.archivedAt) return "archived";
  return publishedRevision > 0 ? "paused" : "draft";
}

function hasPublishedAutomation(
  scheduler: SchedulerSnapshot,
  state: AutomationJournalState,
  automationId: string,
): boolean {
  if (state.definitions.some((item) => item.automationId === automationId)) return true;
  return scheduler.jobs.some((job) => job.target?.kind === "automation" &&
    job.target.automationId === automationId);
}

export function createAutomationDraftManager(options: {
  persistence: AutomationPersistence;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  async function list(): Promise<AutomationDraftSummary[]> {
    const state = await options.persistence.read();
    return state.drafts
      .map((draft) => {
        const publishedRevision = state.definitions
          .filter((item) => item.automationId === draft.automationId)
          .reduce((latest, item) => Math.max(latest, item.revision), 0);
        return {
          id: draft.automationId,
          title: draft.definition.title,
          draftRevision: draft.revision,
          updatedAt: draft.updatedAt,
          ...(publishedRevision > 0 ? { publishedRevision } : {}),
          status: draftStatus(draft, publishedRevision),
        };
      })
      .sort((left, right) => left.title.localeCompare(right.title));
  }

  async function create(
    title: string,
    buildDefinition?: (empty: AutomationRevision) => AutomationRevision,
  ): Promise<AutomationDraftRecord> {
    return createWithAcceptance(title, buildDefinition);
  }

  async function createWithAcceptance(
    title: string,
    buildDefinition?: (empty: AutomationRevision) => AutomationRevision,
    acceptDraft?: (draft: AutomationDraftRecord) => void,
  ): Promise<AutomationDraftRecord> {
    const cleanTitle = title.trim();
    if (!cleanTitle || cleanTitle.length > 160) throw new Error("automation_title_invalid");
    const automationId = randomUUID();
    const empty = createEmptyAutomationDefinition(automationId, cleanTitle);
    const draft: AutomationDraftRecord = {
      id: `draft:${automationId}`,
      automationId,
      revision: 1,
      definition: buildDefinition ? buildDefinition(empty) : empty,
      updatedAt: new Date(now()).toISOString(),
    };
    return options.persistence.update((state) => {
      acceptDraft?.(draft);
      state.drafts.push(draft);
      return draft;
    });
  }

  async function get(automationId: string): Promise<AutomationDraftRecord | null> {
    const state = await options.persistence.read();
    return state.drafts.find((item) => item.automationId === automationId) ?? null;
  }

  async function createPlan(title: string, value: unknown, accept?: AutomationDraftPlanAcceptance) {
    if (!isSupportedDraftPlanAcceptance(accept)) throw new Error("automation_draft_plan_acceptance_invalid");
    const plan = parseAutomationDraftBatch(value);
    let aliases: Readonly<Record<string, string>> = {};
    const draft = await createWithAcceptance(title, (empty) => {
      const built = applyAutomationDraftBatch(empty, plan, 1);
      aliases = built.aliases;
      return built.definition;
    }, (candidate) => requireDraftPlanAcceptance({ draft: candidate, aliases }, accept));
    return { draft, aliases };
  }

  async function applyPlan(automationId: string, expectedRevision: number, value: unknown, accept?: AutomationDraftPlanAcceptance) {
    if (!isSupportedDraftPlanAcceptance(accept)) throw new Error("automation_draft_plan_acceptance_invalid");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error("automation_revision_conflict");
    const plan = parseAutomationDraftBatch(value);
    return options.persistence.update((state) => {
      const index = state.drafts.findIndex((item) => item.automationId === automationId);
      if (index < 0) throw new Error("automation_not_found");
      const current = state.drafts[index]!;
      requireUnarchivedAutomation(state, automationId);
      if (current.revision !== expectedRevision) throw new Error("automation_revision_conflict");
      const built = applyAutomationDraftBatch(current.definition, plan, current.revision + 1);
      const draft: AutomationDraftRecord = {
        ...current, definition: built.definition, revision: built.definition.revision,
        storageRevision: (current.storageRevision ?? current.revision) + 1,
        updatedAt: new Date(now()).toISOString(),
      };
      const result = { draft, aliases: built.aliases };
      requireDraftPlanAcceptance(result, accept);
      state.drafts[index] = draft;
      return result;
    });
  }

  async function deleteUnpublishedDraft(
    automationId: string,
    expectedRevision: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error("automation_revision_conflict");
    await options.persistence.updateWithScheduler((scheduler, state) => {
      const index = state.drafts.findIndex((item) => item.automationId === automationId);
      if (index < 0) throw new Error("automation_not_found");
      if (state.drafts[index]!.revision !== expectedRevision)
        throw new Error("automation_revision_conflict");
      if (hasPublishedAutomation(scheduler, state, automationId))
        throw new Error("automation_draft_published");
      state.drafts.splice(index, 1);
      state.grants = state.grants.filter((item) => item.automationId !== automationId);
    });
  }

  async function update(
    automationId: string,
    expectedRevision: number,
    mutation: unknown,
  ): Promise<AutomationDraftRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new Error("automation_revision_conflict");
    const publishedRevision = readPublishedDraftRestoration(mutation);
    if (publishedRevision !== null) return restorePublishedAutomationDraft({
      persistence: options.persistence, automationId, expectedRevision, publishedRevision, now,
    });
    const parsed = parseDraftMutation(mutation);
    return options.persistence.update((state) => {
      const index = state.drafts.findIndex((item) => item.automationId === automationId);
      if (index < 0) throw new Error("automation_not_found");
      const current = state.drafts[index]!;
      requireUnarchivedAutomation(state, automationId);
      if (current.revision !== expectedRevision)
        throw new Error("automation_revision_conflict");
      const definition = applyDraftMutation(current.definition, parsed);
      const next: AutomationDraftRecord = {
        ...current,
        revision: definition.revision,
        storageRevision: (current.storageRevision ?? current.revision) + 1,
        definition,
        updatedAt: new Date(now()).toISOString(),
      };
      state.drafts[index] = next;
      return next;
    });
  }

  async function validate(automationId: string) {
    const draft = await get(automationId);
    if (!draft) throw new Error("automation_not_found");
    return compileAutomationGraph(draft.definition);
  }

  return { list, create, createPlan, applyPlan, get, deleteUnpublishedDraft, update, validate };
}

export type AutomationDraftManager = ReturnType<typeof createAutomationDraftManager>;
