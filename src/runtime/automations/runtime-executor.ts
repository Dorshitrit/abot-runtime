import type { RuntimeAttachmentStore } from "../attachments/store.js";
import type { RuntimeConfig, SessionStore } from "../ports.js";
import { deleteSessionAttachmentsIfSupported } from "../session/session-attachment-deletion.js";
import { traceDebug } from "../observability/debug-logger.js";
import type {
  SchedulerAutomationExecutor,
  SchedulerAutomationJob,
  SchedulerAutomationRun,
  SchedulerAutomationRunOutcome,
} from "../scheduler/contracts.js";
import { isAutomationSchedulerRun } from "../scheduler/scheduler-target.js";
import { createAutomationOccurrencePreparer } from "./occurrence-preparation.js";
import { createAutomationReplayPreparer } from "./replay-preparation.js";
import { holdInterruptedInputs, releaseNeverDispatchedInputs } from "./input-ledger.js";
import { DEFAULT_AUTOMATION_LIMITS } from "./limits.js";
import { recordAutomationLateSettlements } from "./late-settlement.js";
import { maintainAutomationRetention } from "./retention.js";
import { createAutomationSnapshotStaging } from "./snapshot-staging.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationResultStore } from "./result-store.js";
import type { AutomationToolLifetimes } from "./tool-lifetimes.js";
import type {
  AutomationExecutionRecord,
  AutomationJournalState,
  AutomationNodeStateRecord,
} from "./storage-records.js";

type ActiveExecution = {
  controller: AbortController;
  stopRequested: boolean;
  deadlineMs?: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  budgetTimer?: ReturnType<typeof setTimeout>;
  publishDeadline(outcome: SchedulerAutomationRunOutcome): void;
};

const DERIVED_REPORT = (runId: string) => `derived:${runId}`;

function requireExecution(
  state: AutomationJournalState,
  runId: string,
): AutomationExecutionRecord {
  const execution = state.executions.find((item) => item.id === runId);
  if (!execution) throw new Error("automation_execution_checkpoint_missing");
  return execution;
}

function replaceExecution(
  state: AutomationJournalState,
  execution: AutomationExecutionRecord,
  update: Partial<AutomationExecutionRecord>,
): void {
  const index = state.executions.findIndex((item) => item.id === execution.id);
  if (index < 0) throw new Error("automation_execution_checkpoint_missing");
  state.executions[index] = { ...execution, ...update, revision: execution.revision + 1 };
}

function stoppedNodes(
  nodes: readonly AutomationNodeStateRecord[],
  uncertain: boolean,
): AutomationNodeStateRecord[] {
  return nodes.map((node) => {
    if (node.status === "running") return {
      ...node,
      status: "interrupted" as const,
      errorCode: uncertain ? "automation_effect_uncertain" : "automation_run_stopped",
    };
    if (node.status === "pending" || node.status === "ready") return {
      ...node,
      status: "cancelled" as const,
      errorCode: "automation_run_stopped",
    };
    return node;
  });
}

function markUnsettledAttempts(state: AutomationJournalState, runId: string): boolean {
  let uncertain = false;
  state.attempts = state.attempts.map((attempt) => {
    if (attempt.runId !== runId) return attempt;
    if (attempt.state === "uncertain") {
      uncertain = true;
      return attempt;
    }
    if (attempt.state !== "started") return attempt;
    uncertain = true;
    return { ...attempt, state: "uncertain" as const };
  });
  return uncertain;
}

function markInputOutcome(
  state: AutomationJournalState,
  runId: string,
  reportRef: string,
  hold: boolean,
): void {
  state.inputs = state.inputs.map((record) => record.claimRunId !== runId
    ? record
    : {
        ...record,
        ...(hold ? { eligibility: "held" as const } : {}),
        outcomeRef: reportRef,
      });
}

export function createAutomationRuntimeExecutor(options: {
  config: RuntimeConfig;
  sessions?: SessionStore;
  persistence: AutomationPersistence;
  attachments: RuntimeAttachmentStore;
  results: AutomationResultStore;
  toolLifetimes: AutomationToolLifetimes;
  execute(
    job: SchedulerAutomationJob,
    run: SchedulerAutomationRun,
    signal: AbortSignal,
  ): Promise<SchedulerAutomationRunOutcome>;
  now?: () => number;
}): Omit<SchedulerAutomationExecutor, "tryReserve"> {
  const active = new Map<string, ActiveExecution>();
  const stopsBeforeStart = new Set<string>();
  const snapshots = createAutomationSnapshotStaging({
    runtimeDir: options.config.paths.runtimeDir,
    persistence: options.persistence, attachments: options.attachments,
  });
  const prepare = createAutomationOccurrencePreparer({ ...options, snapshots });
  const prepareReplay = createAutomationReplayPreparer(options);
  let lastMaintenanceAt = Number.NEGATIVE_INFINITY;

  async function reconcileSessions(): Promise<void> {
    const reportFailure = (sessionId: string, error: unknown) => traceDebug(
      "runtime.automations", "agent_session.recovery_failed", {
        sessionId, error: error instanceof Error ? error.message : String(error),
      });
    try {
      await options.sessions?.reconcileAutomationSessions?.(
        (id) => deleteSessionAttachmentsIfSupported(options.attachments, id), reportFailure);
    } catch (error) { reportFailure("", error); }
  }

  async function maintainRetention(now: number): Promise<void> {
    if (now - lastMaintenanceAt < 5 * 60_000) return;
    lastMaintenanceAt = now;
    await reconcileSessions();
    await snapshots.reconcile();
    await maintainAutomationRetention({
      persistence: options.persistence,
      results: options.results,
      attachments: options.attachments,
      now,
    });
  }

  function signalStop(runId: string): void {
    const execution = active.get(runId);
    if (!execution) {
      stopsBeforeStart.add(runId);
      return;
    }
    if (execution.stopRequested) return;
    execution.stopRequested = true;
    execution.controller.abort(new Error("automation_run_stopped"));
    if (execution.deadlineMs !== undefined) scheduleDeadline(runId, execution);
  }

  function scheduleDeadline(runId: string, execution: ActiveExecution): void {
    if (execution.deadlineTimer) return;
    execution.deadlineTimer = setTimeout(() => execution.publishDeadline({
      status: "cancelled",
      error: "automation_stop_deadline_elapsed",
      reportRef: DERIVED_REPORT(runId),
    }), execution.deadlineMs ?? DEFAULT_AUTOMATION_LIMITS.stopReportDeadlineMs);
    execution.deadlineTimer.unref();
  }

  function scheduleBudgetDeadline(
    runId: string,
    execution: ActiveExecution,
    durationMs: number,
  ): void {
    execution.budgetTimer = setTimeout(() => {
      execution.controller.abort(new Error("automation_run_duration_exceeded"));
      execution.publishDeadline({
        status: execution.stopRequested ? "cancelled" : "failed",
        error: "automation_run_deadline_elapsed",
        reportRef: DERIVED_REPORT(runId),
      });
    }, durationMs);
    execution.budgetTimer.unref();
  }

  function start(
    job: SchedulerAutomationJob,
    run: SchedulerAutomationRun,
  ) {
    let publishDeadline!: (outcome: SchedulerAutomationRunOutcome) => void;
    const deadline = new Promise<SchedulerAutomationRunOutcome>((resolve) => {
      publishDeadline = resolve;
    });
    const execution: ActiveExecution = {
      controller: new AbortController(),
      stopRequested: false,
      publishDeadline,
    };
    active.set(run.id, execution);
    if (stopsBeforeStart.delete(run.id)) signalStop(run.id);
    const actual = (async (): Promise<SchedulerAutomationRunOutcome> => {
      const state = await options.persistence.read();
      const definition = state.definitions.find((item) =>
        item.automationId === run.target.automationId &&
        item.revision === run.target.definitionRevision)?.definition;
      if (!definition) throw new Error("automation_definition_not_found");
      execution.deadlineMs = definition.limits.stopReportDeadlineMs;
      if (execution.stopRequested) scheduleDeadline(run.id, execution);
      if (execution.controller.signal.aborted) return {
        status: "cancelled",
        reportRef: DERIVED_REPORT(run.id),
      };
      scheduleBudgetDeadline(run.id, execution,
        definition.limits.maxRunDurationMs + definition.limits.stopReportDeadlineMs);
      return options.execute(job, run, execution.controller.signal);
    })().catch((error: unknown): SchedulerAutomationRunOutcome => ({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      reportRef: DERIVED_REPORT(run.id),
    }));
    const outcome = Promise.race([actual, deadline]);
    // Terminal deadlines detach stalled graph/model work. Tool dispatch is fenced
    // by the aborted signal, and every admitted Tool promise still drains below.
    const resourcesSettled = outcome.then(() => undefined).finally(async () => {
      try {
        const observed = await options.toolLifetimes.whenSettled(run.id);
        await recordAutomationLateSettlements({
          persistence: options.persistence,
          runId: run.id,
          observed,
          now: options.now,
        });
      } finally {
        cleanup(run.id, execution);
      }
    });
    return { outcome, resourcesSettled };
  }

  function cleanup(runId: string, execution: ActiveExecution): void {
    if (execution.deadlineTimer) clearTimeout(execution.deadlineTimer);
    if (execution.budgetTimer) clearTimeout(execution.budgetTimer);
    if (active.get(runId) === execution) active.delete(runId);
  }

  function recover(
    scheduler: Parameters<SchedulerAutomationExecutor["recover"]>[0],
    automations: AutomationJournalState,
    recoveredRunIds: readonly string[],
  ): void {
    for (const runId of recoveredRunIds) {
      const run = scheduler.runs.find((item) => item.id === runId);
      if (!run || !isAutomationSchedulerRun(run))
        throw new Error("automation_run_not_found");
      let execution = automations.executions.find((item) => item.id === runId);
      if (!execution) {
        execution = {
          id: runId,
          automationId: run.target.automationId,
          definitionRevision: run.target.definitionRevision,
          revision: 1,
          inputIds: [],
          nodes: [],
        };
        automations.executions.push(execution);
      }
      const missed = run.status === "missed";
      if (missed) releaseNeverDispatchedInputs(automations, runId);
      else holdInterruptedInputs(automations, runId);
      const uncertain = missed ? false : markUnsettledAttempts(automations, runId);
      replaceExecution(automations, execution, {
        nodes: stoppedNodes(execution.nodes, uncertain),
        reportRef: DERIVED_REPORT(runId),
        terminalAt: new Date(options.now?.() ?? Date.now()).toISOString(),
      });
      run.reportRef = DERIVED_REPORT(runId);
    }
  }

  function settle(
    run: SchedulerAutomationRun,
    state: AutomationJournalState,
    outcome: SchedulerAutomationRunOutcome,
  ): void {
    const execution = requireExecution(state, run.id);
    if (!outcome.reportRef) throw new Error("automation_report_missing");
    const derived = outcome.reportRef === DERIVED_REPORT(run.id);
    const successful = outcome.status === "succeeded" ||
      outcome.status === "completed_with_skips";
    if (derived && successful && (
      execution.nodes.some((node) =>
        node.status === "pending" || node.status === "ready" || node.status === "running") ||
      state.attempts.some((item) => item.runId === run.id && item.state !== "settled")
    )) throw new Error("automation_run_not_settled");
    if (!derived && !state.results.some((item) => item.id === outcome.reportRef &&
        item.runId === run.id && item.kind === "report"))
      throw new Error("automation_report_missing");
    const uncertain = derived ? markUnsettledAttempts(state, run.id) :
      state.attempts.some((item) => item.runId === run.id &&
        (item.state === "started" || item.state === "uncertain"));
    replaceExecution(state, execution, {
      ...(derived ? { nodes: stoppedNodes(execution.nodes, uncertain) } : {}),
      reportRef: outcome.reportRef,
      terminalAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    });
    markInputOutcome(state, run.id, outcome.reportRef, uncertain || (derived && !successful));
  }

  function cancelPending(
    run: SchedulerAutomationRun,
    state: AutomationJournalState,
  ): void {
    const execution = requireExecution(state, run.id);
    releaseNeverDispatchedInputs(state, run.id);
    replaceExecution(state, execution, {
      nodes: stoppedNodes(execution.nodes, false),
      reportRef: DERIVED_REPORT(run.id),
      terminalAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    });
  }

  return { prepare, prepareReplay, start, stop: signalStop, recover, settle,
    cancelPending, maintainRetention, reconcileSessions };
}
