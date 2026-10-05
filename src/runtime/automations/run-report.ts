import type { SchedulerAutomationRun } from "../scheduler/contracts.js";
import type { AutomationRevision } from "./definition-contracts.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationResultStore } from "./result-store.js";
import type {
  AutomationAttemptRecord,
  AutomationExecutionRecord,
  AutomationResultRecord,
} from "./storage-records.js";
import { remainingAutomationResultBytes, requireAutomationResultCapacity } from "./result-capacity.js";
import { publishAutomationResult } from "./result-publication.js";
import {
  findAutomationStep, readAutomationRunEffectSummary, type AutomationRunEffectSummary,
} from "./step-evidence-effects.js";

export type AutomationRunReport = Readonly<{
  runId: string;
  automationId: string;
  definitionRevision: number;
  outcome: "succeeded" | "completed_with_skips" | "failed" | "cancelled" | "interrupted" | "missed";
  startedAt: string | null;
  finishedAt: string;
  inputIds: readonly string[];
  inputVersions: readonly Readonly<{
    inputId: string;
    sourceId: string;
    canonicalPath: string;
    contentVersion: string;
  }>[];
  nodeResults: readonly Readonly<{
    nodeId: string;
    title?: string;
    status: string;
    errorCode?: string;
    resultRef?: string;
  }>[];
  uncertainEffects: readonly Readonly<{
    nodeId: string;
    attemptId: string;
  }>[];
  /** Supplemental evidence does not change the terminal run outcome. */
  lateEvidence: readonly Readonly<{
    nodeId: string;
    attemptId: string;
    revision: number;
    observedAt: string;
    status: "succeeded" | "failed" | "rejected";
    errorCode?: string;
  }>[];
  artifacts: readonly Readonly<{ id: string; nodeId?: string; kind: string }>[];
  effectSummary?: AutomationRunEffectSummary;
  modelCalls: number | null;
  toolCalls: number | null;
  /** Admitted attempts consume the tool limit even when execution is rejected. */
  toolAttempts?: number;
}>;

export function verifiedToolCallCount(
  summary: AutomationRunEffectSummary | undefined,
  admittedAttempts: number,
): number | null {
  if (!summary) return admittedAttempts === 0 ? 0 : null;
  if (summary.unresolvedAttempts > 0) return null;
  return summary.verifiedExecutions;
}

export function createAutomationReportService(options: {
  persistence: AutomationPersistence;
  results: AutomationResultStore;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  async function create(input: {
    run: SchedulerAutomationRun;
    definition: AutomationRevision;
    outcome: AutomationRunReport["outcome"];
  }): Promise<{ report: AutomationRunReport; record: AutomationResultRecord }> {
    const state = await options.persistence.read();
    const execution = state.executions.find((item) => item.id === input.run.id);
    if (!execution) throw new Error("automation_run_not_found");
    const effectSummary = await readAutomationRunEffectSummary({
      state, results: options.results, runId: input.run.id, definition: input.definition,
    });
    const report = buildAutomationRunReport({
      run: input.run,
      definition: input.definition,
      execution,
      inputs: state.inputs.filter((item) => execution.inputIds.includes(item.id)),
      attempts: state.attempts.filter((item) => item.runId === input.run.id),
      results: state.results.filter((item) => item.runId === input.run.id),
      outcome: input.outcome,
      finishedAt: new Date(now()).toISOString(),
      effectSummary,
    });
    const usedBytes = state.results
      .filter((item) => item.runId === input.run.id)
      .reduce((sum, item) => sum + item.sizeBytes, 0);
    const remaining = input.definition.limits.maxStoredArtifactBytes - usedBytes;
    const record = await options.results.save({
      runId: input.run.id,
      kind: "report",
      value: report,
      maxBytes: Math.min(remaining, remainingAutomationResultBytes(state)),
      at: report.finishedAt,
    });
    await publishAutomationResult({ ...options, record,
      publish: () => options.persistence.update((current) => {
        if (!current.executions.some((item) => item.id === input.run.id))
          throw new Error("automation_run_not_found");
        if (current.results.some((item) => item.id === record.id))
          throw new Error("automation_result_duplicate");
        const used = current.results.filter((item) => item.runId === input.run.id)
          .reduce((sum, item) => sum + item.sizeBytes, record.sizeBytes);
        if (used > input.definition.limits.maxStoredArtifactBytes)
          throw new Error("automation_artifact_budget_exhausted");
        requireAutomationResultCapacity(current, record.sizeBytes);
        current.results.push(record);
      }),
    });
    return { report, record };
  }

  return { create };
}

export function buildAutomationRunReport(input: {
  run: SchedulerAutomationRun;
  definition: AutomationRevision;
  execution: AutomationExecutionRecord;
  inputs: readonly {
    id: string;
    sourceId: string;
    canonicalPath: string;
    contentVersion: string;
  }[];
  attempts: readonly Pick<AutomationAttemptRecord, "id" | "nodeId" | "state" | "lateSettlement">[];
  results: readonly AutomationResultRecord[];
  outcome: AutomationRunReport["outcome"];
  finishedAt: string;
  effectSummary?: AutomationRunEffectSummary;
}): AutomationRunReport {
  const hasAgent = input.execution.nodes.some((node) =>
    containsAgent(input.definition.body, node.nodeId));
  return {
    runId: input.run.id,
    automationId: input.execution.automationId,
    definitionRevision: input.execution.definitionRevision,
    outcome: input.outcome,
    startedAt: input.run.startedAt ?? null,
    finishedAt: input.finishedAt,
    inputIds: input.execution.inputIds,
    inputVersions: input.inputs.map((item) => ({
      inputId: item.id,
      sourceId: item.sourceId,
      canonicalPath: item.canonicalPath,
      contentVersion: item.contentVersion,
    })),
    nodeResults: input.execution.nodes.map((node) => {
      const step = findAutomationStep(input.definition.body, node.nodeId);
      return {
        nodeId: node.nodeId,
        ...(step ? { title: step.title } : {}),
        status: node.status,
        ...(node.errorCode ? { errorCode: node.errorCode } : {}),
        ...(node.resultRef ? { resultRef: node.resultRef } : {}),
      };
    }),
    uncertainEffects: input.attempts
      .filter((attempt) => attempt.state === "uncertain" || attempt.state === "started")
      .map((attempt) => ({ nodeId: attempt.nodeId, attemptId: attempt.id })),
    lateEvidence: projectAutomationLateEvidence(input.attempts),
    artifacts: input.results
      .filter((result) => result.kind === "artifact")
      .map((result) => ({
        id: result.id,
        ...(result.nodeId ? { nodeId: result.nodeId } : {}),
        kind: result.kind,
      })),
    ...(input.effectSummary ? { effectSummary: input.effectSummary } : {}),
    modelCalls: input.execution.modelCalls ?? (hasAgent ? null : 0),
    // A durable pre-dispatch attempt is not proof that the invocation ran.
    toolCalls: verifiedToolCallCount(input.effectSummary, input.attempts.length),
    toolAttempts: input.attempts.length,
  };
}

export function projectAutomationLateEvidence(
  attempts: readonly Pick<AutomationAttemptRecord, "id" | "nodeId" | "lateSettlement">[],
): AutomationRunReport["lateEvidence"] {
  return attempts.flatMap((attempt) => attempt.lateSettlement ? [{
    nodeId: attempt.nodeId,
    attemptId: attempt.id,
    ...attempt.lateSettlement,
  }] : []);
}

function containsAgent(
  node: AutomationRevision["body"],
  nodeId: string,
): boolean {
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as { kind: string; id: string; children?: unknown[]; branches?: unknown[] };
    if (current.id === nodeId) return current.kind === "agent";
    stack.push(...(current.children ?? []), ...(current.branches ?? []));
  }
  return false;
}
