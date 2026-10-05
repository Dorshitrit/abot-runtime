import type { RuntimeAttachmentStore } from "../attachments/store.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationResultStore } from "./result-store.js";
import type {
  AutomationAttemptRecord,
  AutomationExecutionRecord,
  AutomationInputRecord,
  AutomationJournalState,
  AutomationResultRecord,
} from "./storage-records.js";

export const AUTOMATION_DETAIL_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const AUTOMATION_REPORT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_RESULT_CLEANUP = 64;
const MAX_SNAPSHOT_CLEANUP = 32;

function hasUnresolvedEffect(state: AutomationJournalState, runId: string): boolean {
  return state.attempts.some((attempt) => attempt.runId === runId &&
    hasUnresolvedAttemptEffect(attempt));
}

function hasUnresolvedAttemptEffect(attempt: AutomationAttemptRecord): boolean {
  if (attempt.state === "started") return true;
  if (attempt.state !== "uncertain") return false;
  // Late evidence resolves resource uncertainty without rewriting the historical outcome.
  if (attempt.lateSettlement?.status === "succeeded") return false;
  if (attempt.lateSettlement?.status === "failed") return false;
  return true;
}

function olderThan(terminalAt: string | undefined, now: number, ageMs: number): boolean {
  return terminalAt !== undefined && Date.parse(terminalAt) <= now - ageMs;
}

function updateExecution(
  state: AutomationJournalState,
  current: AutomationExecutionRecord,
  patch: Partial<AutomationExecutionRecord>,
): AutomationExecutionRecord {
  const next = { ...current, ...patch, revision: current.revision + 1 };
  state.executions[state.executions.indexOf(current)] = next;
  return next;
}

function markRunPayloads(state: AutomationJournalState, now: number, at: string): void {
  for (const initial of [...state.executions]) {
    if (!initial.terminalAt || hasUnresolvedEffect(state, initial.id)) continue;
    let execution = initial;
    if (olderThan(execution.terminalAt, now, AUTOMATION_DETAIL_RETENTION_MS) &&
        !execution.detailsExpiredAt)
      execution = updateExecution(state, execution, { detailsExpiredAt: at });
    if (olderThan(execution.terminalAt, now, AUTOMATION_REPORT_RETENTION_MS) &&
        !execution.reportExpiredAt)
      updateExecution(state, execution, { reportExpiredAt: at });
  }
}

function expiredResult(
  record: AutomationResultRecord,
  executions: ReadonlyMap<string, AutomationExecutionRecord>,
): boolean {
  const execution = executions.get(record.runId);
  return record.kind === "report"
    ? execution?.reportExpiredAt !== undefined
    : execution?.detailsExpiredAt !== undefined;
}

function snapshotCanExpire(
  state: AutomationJournalState,
  record: AutomationInputRecord,
): boolean {
  if (!record.snapshot) return false;
  if (!record.claimRunId) return false;
  const references = state.executions.filter((execution) =>
    execution.inputIds.includes(record.id));
  return references.length > 0 && references.every((execution) =>
    execution.reportExpiredAt !== undefined && !hasUnresolvedEffect(state, execution.id));
}

function markSnapshots(state: AutomationJournalState, at: string): void {
  let available = MAX_SNAPSHOT_CLEANUP;
  for (const record of state.inputs) {
    if (available === 0) break;
    if (record.snapshotRetiredAt || !snapshotCanExpire(state, record)) continue;
    const outcomeRef = record.outcomeRef ?? inputClaimReport(state, record);
    if (!outcomeRef) continue;
    state.inputs[state.inputs.indexOf(record)] = { ...record, outcomeRef, snapshotRetiredAt: at };
    available -= 1;
  }
}

function inputClaimReport(state: AutomationJournalState, record: AutomationInputRecord): string | undefined {
  return state.executions.find((execution) =>
    execution.id === record.claimRunId && execution.inputIds.includes(record.id))?.reportRef;
}

function ownedSnapshot(record: AutomationInputRecord): boolean {
  const parts = record.snapshot?.attachment.storageRef.split(/[\\/]/u);
  return Boolean(record.claimRunId && parts?.[0] === record.claimRunId &&
    parts[1] === record.id && parts.length === 3);
}

/** Runs from the existing scheduler tick; marking survives a crash before file cleanup. */
export async function maintainAutomationRetention(input: {
  persistence: AutomationPersistence;
  results: AutomationResultStore;
  attachments: RuntimeAttachmentStore;
  now: number;
}): Promise<void> {
  await input.results.reconcileUncommitted(input.persistence);
  const at = new Date(input.now).toISOString();
  const pending = await input.persistence.update((state) => {
    markRunPayloads(state, input.now, at);
    markSnapshots(state, at);
    const executions = new Map(state.executions.map((item) => [item.id, item]));
    return {
      results: state.results.filter((record) => expiredResult(record, executions))
        .slice(0, MAX_RESULT_CLEANUP),
      inputs: state.inputs.filter((record) => record.snapshotRetiredAt && record.snapshot)
        .slice(0, MAX_SNAPSHOT_CLEANUP),
    };
  });
  const removedResultIds = new Set<string>();
  const removedInputIds = new Set<string>();
  let failure: unknown;
  for (const record of pending.results) {
    try {
      await input.results.discardUncommitted(record);
      removedResultIds.add(record.id);
    } catch (error) { failure ??= error; }
  }
  for (const record of pending.inputs) {
    try {
      if (!ownedSnapshot(record)) throw new Error("automation_snapshot_owner_invalid");
      if (!input.attachments.deleteAttachment)
        throw new Error("automation_attachment_cleanup_unavailable");
      await input.attachments.deleteAttachment(record.snapshot!.attachment, {
        sessionId: record.claimRunId,
      });
      removedInputIds.add(record.id);
    } catch (error) { failure ??= error; }
  }
  if (removedResultIds.size || removedInputIds.size) {
    await input.persistence.update((state) => {
      const executions = new Map(state.executions.map((item) => [item.id, item]));
      state.results = state.results.filter((record) =>
        !removedResultIds.has(record.id) || !expiredResult(record, executions));
      state.inputs = state.inputs.map((record) => {
        if (!removedInputIds.has(record.id) || !record.snapshotRetiredAt) return record;
        const { snapshot: _snapshot, snapshotRetiredAt: _retired, ...metadata } = record;
        return metadata;
      });
    });
  }
  if (failure) throw failure;
}
