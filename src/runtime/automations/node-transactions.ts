import type { CompiledAutomationGraph } from "./graph-validation.js";
import type { AutomationPersistence } from "./persistence.js";
import type {
  AutomationAttemptRecord,
  AutomationExecutionRecord,
  AutomationNodeStateRecord,
  AutomationResultRecord,
} from "./storage-records.js";
import { requireAutomationResultCapacity } from "./result-capacity.js";
import { settleTerminalUndispatchedAdmission } from "./terminal-admission-receipt.js";

type TerminalNodeStatus = Extract<
  AutomationNodeStateRecord["status"],
  "succeeded" | "skipped" | "failed" | "cancelled" | "interrupted"
>;

function requireExecution(
  state: Awaited<ReturnType<AutomationPersistence["read"]>>,
  runId: string,
): AutomationExecutionRecord {
  const execution = state.executions.find((item) => item.id === runId);
  if (!execution) throw new Error("automation_run_not_found");
  return execution;
}

function requireNode(execution: AutomationExecutionRecord, nodeId: string): AutomationNodeStateRecord {
  const node = execution.nodes.find((item) => item.nodeId === nodeId);
  if (!node) throw new Error("automation_node_not_found");
  return node;
}

function replaceExecution(
  state: Awaited<ReturnType<AutomationPersistence["read"]>>,
  current: AutomationExecutionRecord,
  patch: Partial<AutomationExecutionRecord>,
): AutomationExecutionRecord {
  const next = { ...current, ...patch, revision: current.revision + 1 };
  const index = state.executions.findIndex((item) => item.id === current.id);
  state.executions[index] = next;
  return next;
}

function replaceNode(
  execution: AutomationExecutionRecord,
  nodeId: string,
  patch: Partial<AutomationNodeStateRecord>,
): AutomationNodeStateRecord[] {
  return execution.nodes.map((node) => node.nodeId === nodeId ? { ...node, ...patch } : node);
}

export function createAutomationNodeTransactions(options: {
  persistence: AutomationPersistence;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;

  async function begin(input: {
    runId: string;
    automationId: string;
    definitionRevision: number;
    inputIds: readonly string[];
    graph: CompiledAutomationGraph;
  }): Promise<AutomationExecutionRecord> {
    return options.persistence.update((state) => {
      const claimed = state.executions.find((item) => item.id === input.runId);
      if (claimed && (claimed.automationId !== input.automationId ||
          claimed.definitionRevision !== input.definitionRevision ||
          claimed.stopRequestedAt || claimed.reportRef || claimed.nodes.length > 0 ||
          claimed.inputIds.length !== input.inputIds.length ||
          claimed.inputIds.some((id, index) => id !== input.inputIds[index])))
        throw new Error("automation_run_already_started");
      const execution: AutomationExecutionRecord = {
        id: input.runId,
        automationId: input.automationId,
        definitionRevision: input.definitionRevision,
        revision: claimed ? claimed.revision + 1 : 1,
        inputIds: [...input.inputIds],
        nodes: input.graph.steps.map((step) => ({ nodeId: step.id, status: "pending" })),
      };
      if (claimed) {
        state.executions[state.executions.indexOf(claimed)] = execution;
      } else {
        state.executions.push(execution);
      }
      return execution;
    });
  }

  async function startNode(runId: string, nodeId: string): Promise<void> {
    await options.persistence.update((state) => {
      const execution = requireExecution(state, runId);
      const node = requireNode(execution, nodeId);
      if (execution.stopRequestedAt || execution.reportRef || node.status !== "pending")
        throw new Error("automation_run_locked");
      replaceExecution(state, execution, {
        nodes: replaceNode(execution, nodeId, { status: "running" }),
      });
    });
  }

  async function recordAttempt(input: {
    runId: string;
    nodeId: string;
    invocationId: string;
    fingerprint: string;
    maxToolCalls?: number;
  }): Promise<AutomationAttemptRecord> {
    return options.persistence.update((state) => {
      const execution = requireExecution(state, input.runId);
      const node = requireNode(execution, input.nodeId);
      if (execution.stopRequestedAt || execution.reportRef || node.status !== "running" || node.attemptId)
        throw new Error("automation_run_locked");
      if (state.attempts.some((item) => item.invocationId === input.invocationId))
        throw new Error("automation_attempt_duplicate");
      if (input.maxToolCalls !== undefined &&
          state.attempts.filter((item) => item.runId === input.runId).length >= input.maxToolCalls)
        throw new Error("automation_tool_call_limit_reached");
      const attempt: AutomationAttemptRecord = {
        id: input.invocationId,
        runId: input.runId,
        nodeId: input.nodeId,
        invocationId: input.invocationId,
        fingerprint: input.fingerprint,
        state: "started",
        startedAt: new Date(now()).toISOString(),
      };
      state.attempts.push(attempt);
      replaceExecution(state, execution, {
        nodes: replaceNode(execution, input.nodeId, { attemptId: attempt.id }),
      });
      return attempt;
    });
  }

  async function recordAgentAttempt(input: {
    runId: string;
    nodeId: string;
    invocationId: string;
    fingerprint: string;
    maxToolCalls: number;
  }): Promise<AutomationAttemptRecord> {
    return options.persistence.update((state) => {
      const execution = requireExecution(state, input.runId);
      const node = requireNode(execution, input.nodeId);
      if (execution.stopRequestedAt || execution.reportRef || node.status !== "running")
        throw new Error("automation_run_locked");
      if (state.attempts.some((item) => item.invocationId === input.invocationId))
        throw new Error("automation_attempt_duplicate");
      if (state.attempts.filter((item) => item.runId === input.runId).length >= input.maxToolCalls)
        throw new Error("automation_tool_call_limit_reached");
      const attempt: AutomationAttemptRecord = {
        id: input.invocationId,
        runId: input.runId,
        nodeId: input.nodeId,
        invocationId: input.invocationId,
        fingerprint: input.fingerprint,
        state: "started",
        startedAt: new Date(now()).toISOString(),
      };
      state.attempts.push(attempt);
      replaceExecution(state, execution, {});
      return attempt;
    });
  }

  async function recordModelCall(runId: string, nodeId: string, maxModelCalls: number): Promise<number> {
    return options.persistence.update((state) => {
      const execution = requireExecution(state, runId);
      const node = requireNode(execution, nodeId);
      if (execution.stopRequestedAt || execution.reportRef || node.status !== "running")
        throw new Error("automation_run_locked");
      const count = execution.modelCalls ?? 0;
      if (count >= maxModelCalls) throw new Error("automation_model_call_limit_reached");
      replaceExecution(state, execution, { modelCalls: count + 1 });
      return count + 1;
    });
  }

  async function settleAgentAttempt(input: {
    runId: string;
    nodeId: string;
    invocationId: string;
    result: AutomationResultRecord;
    uncertain: boolean;
    notDispatched?: boolean;
    maxStoredArtifactBytes: number;
  }): Promise<void> {
    await options.persistence.update((state) => {
      const execution = requireExecution(state, input.runId);
      requireNode(execution, input.nodeId);
      const isTerminalUndispatchedAdmission = Boolean(execution.reportRef) && input.notDispatched === true;
      if (isTerminalUndispatchedAdmission) return settleTerminalUndispatchedAdmission({
        ...input, state, execution, resultKind: "effect_receipt", now: now(),
      });
      const index = state.attempts.findIndex((item) =>
        item.id === input.invocationId && item.runId === input.runId && item.nodeId === input.nodeId);
      if (index < 0 || state.attempts[index]!.state !== "started")
        throw new Error("automation_attempt_mismatch");
      if (input.result.runId !== input.runId || input.result.nodeId !== input.nodeId ||
          input.result.kind !== "effect_receipt")
        throw new Error("automation_result_ref_invalid");
      const used = state.results.filter((item) => item.runId === input.runId)
        .reduce((total, item) => total + item.sizeBytes, input.result.sizeBytes);
      if (used > input.maxStoredArtifactBytes)
        throw new Error("automation_artifact_budget_exhausted");
      requireAutomationResultCapacity(state, input.result.sizeBytes);
      state.results.push(input.result);
      state.attempts[index] = {
        ...state.attempts[index]!,
        state: input.uncertain ? "uncertain" : "settled",
        settledAt: new Date(now()).toISOString(),
        settlementRef: input.result.id,
      };
      replaceExecution(state, execution, {});
    });
  }

  async function hasUnsettledEffect(runId: string, nodeId: string): Promise<boolean> {
    const state = await options.persistence.read();
    return state.attempts.some((item) => item.runId === runId && item.nodeId === nodeId &&
      (item.state === "started" || item.state === "uncertain"));
  }

  async function settleNode(input: {
    runId: string;
    nodeId: string;
    status: TerminalNodeStatus;
    attemptId?: string;
    result?: AutomationResultRecord;
    maxStoredArtifactBytes?: number;
    errorCode?: string;
    uncertain?: boolean;
    notDispatched?: boolean;
  }): Promise<void> {
    await options.persistence.update((state) => {
      const execution = requireExecution(state, input.runId);
      const node = requireNode(execution, input.nodeId);
      const isTerminalUndispatchedAdmission = Boolean(execution.reportRef) && input.notDispatched === true;
      if (isTerminalUndispatchedAdmission) return settleTerminalUndispatchedAdmission({
        ...input, state, execution, invocationId: input.attemptId, result: input.result,
        maxStoredArtifactBytes: input.maxStoredArtifactBytes, resultKind: "node_output", now: now(),
      });
      if (execution.reportRef) throw new Error("automation_run_locked");
      if (node.status !== "running" && node.status !== "pending")
        throw new Error("automation_node_already_settled");
      if (node.attemptId !== input.attemptId)
        throw new Error("automation_attempt_mismatch");
      if (input.result) {
        if (input.result.runId !== input.runId || input.result.nodeId !== input.nodeId)
          throw new Error("automation_result_ref_invalid");
        if (input.maxStoredArtifactBytes !== undefined &&
            state.results.filter((item) => item.runId === input.runId)
              .reduce((total, item) => total + item.sizeBytes, input.result.sizeBytes) >
              input.maxStoredArtifactBytes)
          throw new Error("automation_artifact_budget_exhausted");
        requireAutomationResultCapacity(state, input.result.sizeBytes);
        state.results.push(input.result);
      }
      if (input.attemptId) {
        const index = state.attempts.findIndex((item) => item.id === input.attemptId);
        if (index < 0 || state.attempts[index]!.state !== "started")
          throw new Error("automation_attempt_mismatch");
        state.attempts[index] = {
          ...state.attempts[index]!,
          state: input.uncertain ? "uncertain" : "settled",
          settledAt: new Date(now()).toISOString(),
          ...(input.result ? { settlementRef: input.result.id } : {}),
        };
      }
      replaceExecution(state, execution, {
        nodes: replaceNode(execution, input.nodeId, {
          status: input.status,
          ...(input.result ? { resultRef: input.result.id } : {}),
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        }),
      });
    });
  }

  async function requestStop(runId: string): Promise<void> {
    await options.persistence.update((state) => {
      const execution = requireExecution(state, runId);
      if (execution.stopRequestedAt) return;
      replaceExecution(state, execution, { stopRequestedAt: new Date(now()).toISOString() });
    });
  }

  async function get(runId: string): Promise<AutomationExecutionRecord | null> {
    const state = await options.persistence.read();
    return state.executions.find((item) => item.id === runId) ?? null;
  }

  return { begin, startNode, recordAttempt, recordAgentAttempt,
    recordModelCall, settleAgentAttempt, hasUnsettledEffect, settleNode, requestStop, get };
}

export type AutomationNodeTransactions = ReturnType<typeof createAutomationNodeTransactions>;
