import type { AutomationRevision } from "./definition-contracts.js";
import type { CompiledAutomationGraph, CompiledAutomationStep } from "./graph-validation.js";
import type { AutomationNodeTransactions } from "./node-transactions.js";
import { normalizeAutomationStepInterruption } from "./step-interruption.js";

export type AutomationStepCompletion = Readonly<{
  status: "succeeded" | "skipped" | "failed" | "cancelled" | "interrupted";
  errorCode?: string;
  uncertain?: boolean;
}>;

export type AutomationGraphOutcome = Readonly<{
  status: "succeeded" | "completed_with_skips" | "failed" | "cancelled";
  errorCode?: string;
  nodeResults: ReadonlyMap<string, AutomationStepCompletion>;
}>;

type ActiveStepResult =
  | Readonly<{ kind: "completed"; id: string; completion: AutomationStepCompletion }>
  | Readonly<{ kind: "errored"; id: string; error: unknown }>;

function isTerminal(status: string): status is AutomationStepCompletion["status"] {
  return ["succeeded", "skipped", "failed", "cancelled", "interrupted"].includes(status);
}

function failureStatus(step: CompiledAutomationStep, uncertain: boolean): AutomationStepCompletion["status"] {
  if (uncertain) return "failed";
  return step.node.onFailure === "skip" ? "skipped" : "failed";
}

function interruptedStepCompletion(budgetExhausted: boolean): AutomationStepCompletion {
  if (budgetExhausted) return { status: "failed", errorCode: "automation_run_duration_exceeded" };
  return { status: "cancelled", errorCode: "automation_run_stopped" };
}

function normalizeReturnedCompletion(
  step: CompiledAutomationStep, completion: AutomationStepCompletion,
  budgetExhausted: boolean, signal: AbortSignal,
): AutomationStepCompletion {
  completion = normalizeAutomationStepInterruption(completion, signal);
  if (completion.uncertain) return completion;
  if (budgetExhausted && completion.status === "cancelled") return interruptedStepCompletion(true);
  if (budgetExhausted) return completion;
  if (completion.status !== "failed") return completion;
  if (step.node.onFailure !== "skip") return completion;
  return { ...completion, status: "skipped" };
}

function rejectedStepCompletion(
  step: CompiledAutomationStep, error: unknown, unsettledEffect: boolean,
  aborted: boolean, budgetExhausted: boolean,
): AutomationStepCompletion {
  if (unsettledEffect)
    return { status: "failed", errorCode: "automation_effect_uncertain", uncertain: true };
  if (aborted) return interruptedStepCompletion(budgetExhausted);
  return { status: failureStatus(step, false), errorCode: error instanceof Error ? error.message : String(error) };
}

function terminalRunStatus(
  completions: readonly AutomationStepCompletion[],
  stopped: boolean,
): AutomationGraphOutcome["status"] {
  if (completions.some((item) => item.status === "failed" || item.status === "interrupted"))
    return "failed";
  const hasCancelledStep = completions.some((item) => item.status === "cancelled");
  if (stopped || hasCancelledStep) return "cancelled";
  if (completions.some((item) => item.status === "skipped")) return "completed_with_skips";
  return "succeeded";
}

export async function executeAutomationGraph(input: {
  runId: string;
  automationId: string;
  definition: AutomationRevision;
  inputIds: readonly string[];
  graph: CompiledAutomationGraph;
  transactions: AutomationNodeTransactions;
  abortSignal?: AbortSignal;
  executeStep(
    step: CompiledAutomationStep,
    signal: AbortSignal,
  ): Promise<AutomationStepCompletion>;
}): Promise<AutomationGraphOutcome> {
  await input.transactions.begin({
    runId: input.runId,
    automationId: input.automationId,
    definitionRevision: input.definition.revision,
    inputIds: input.inputIds,
    graph: input.graph,
  });
  const controller = new AbortController();
  let budgetExhausted = false;
  const propagateAbort = () => controller.abort(input.abortSignal?.reason);
  input.abortSignal?.addEventListener("abort", propagateAbort, { once: true });
  if (input.abortSignal?.aborted) propagateAbort();
  const timeout = setTimeout(() => {
    // Preserve the first stop cause; a later timer cannot turn a user stop into a failure.
    if (controller.signal.aborted) return;
    budgetExhausted = true;
    controller.abort(new Error("automation_run_duration_exceeded"));
  }, input.definition.limits.maxRunDurationMs);
  timeout.unref();
  const pending = new Map(input.graph.steps.map((step) => [step.id, step]));
  const active = new Map<string, Promise<ActiveStepResult>>();
  const settled = new Map<string, AutomationStepCompletion>();
  let stopped = false;
  let errorCode: string | undefined;
  let fatalError: unknown;
  let hasFatalError = false;

  function stopAfterFatal(error: unknown): void {
    if (!hasFatalError) fatalError = error;
    hasFatalError = true;
    stopped = true;
    controller.abort(error);
  }

  async function executeAndSettle(step: CompiledAutomationStep) {
    try {
      await input.transactions.startNode(input.runId, step.id);
    } catch (error) {
      const execution = await input.transactions.get(input.runId);
      if (!execution?.stopRequestedAt && !controller.signal.aborted) throw error;
      const completion = interruptedStepCompletion(budgetExhausted);
      await input.transactions.settleNode({
        runId: input.runId,
        nodeId: step.id,
        ...completion,
      });
      return { id: step.id, completion };
    }
    let completion: AutomationStepCompletion;
    try {
      completion = normalizeReturnedCompletion(step,
        await input.executeStep(step, controller.signal), budgetExhausted, controller.signal);
    } catch (error) {
      const execution = await input.transactions.get(input.runId);
      const attempted = execution?.nodes.find((node) => node.nodeId === step.id)?.attemptId;
      const unsettledEffect = Boolean(attempted) ||
        await input.transactions.hasUnsettledEffect(input.runId, step.id);
      completion = rejectedStepCompletion(step, error, unsettledEffect,
        controller.signal.aborted, budgetExhausted);
    }
    const execution = await input.transactions.get(input.runId);
    const durable = execution?.nodes.find((node) => node.nodeId === step.id);
    if (!durable) throw new Error("automation_node_not_found");
    if (durable.status === "running") {
      if (completion.status === "succeeded") {
        completion = {
          status: "failed", errorCode: "automation_result_not_recorded",
          uncertain: Boolean(durable.attemptId),
        };
      }
      await input.transactions.settleNode({
        runId: input.runId,
        nodeId: step.id,
        status: completion.status,
        ...(durable.attemptId ? { attemptId: durable.attemptId } : {}),
        ...(completion.errorCode ? { errorCode: completion.errorCode } : {}),
        ...(completion.uncertain ? { uncertain: true } : {}),
      });
    } else if (!isTerminal(durable.status)) {
      throw new Error("automation_node_not_settled");
    } else if (durable.status !== completion.status) {
      throw new Error("automation_node_settlement_mismatch");
    } else if (completion.status === "succeeded" && !durable.resultRef) {
      throw new Error("automation_result_not_recorded");
    }
    return { id: step.id, completion };
  }

  try {
    while (pending.size > 0 || active.size > 0) {
      const execution = await input.transactions.get(input.runId).catch((error: unknown) => {
        stopAfterFatal(error);
        return null;
      });
      if (execution?.stopRequestedAt || controller.signal.aborted) {
        stopped = true;
        controller.abort();
      }
      if (!stopped) {
        for (const step of pending.values()) {
          if (active.size >= input.definition.limits.maxConcurrentNodes) break;
          if (!step.dependsOn.every((id) => settled.has(id))) continue;
          pending.delete(step.id);
          active.set(step.id, executeAndSettle(step).then(
            (result): ActiveStepResult => ({ kind: "completed", ...result }),
            (error: unknown): ActiveStepResult => ({ kind: "errored", id: step.id, error }),
          ));
        }
      }
      if (active.size === 0) {
        if (stopped) break;
        if (pending.size > 0) throw new Error("automation_dependency_missing");
        break;
      }
      const next = await Promise.race(active.values());
      active.delete(next.id);
      if (next.kind === "errored") {
        stopAfterFatal(next.error);
        try { await input.transactions.requestStop(input.runId); }
        catch (error) { stopAfterFatal(error); }
        continue;
      }
      settled.set(next.id, next.completion);
      const failed = next.completion.status === "failed" || next.completion.status === "interrupted";
      if (next.completion.uncertain || (failed && pendingFailureStops(input.graph, next.id))) {
        errorCode = next.completion.errorCode ?? "automation_step_failed";
        stopped = true;
        try { await input.transactions.requestStop(input.runId); }
        catch (error) { stopAfterFatal(error); }
        controller.abort(new Error(errorCode));
      }
    }
    for (const step of pending.values()) {
      const completion: AutomationStepCompletion = stopped
        ? interruptedStepCompletion(budgetExhausted)
        : { status: "failed", errorCode: "automation_dependency_missing" };
      try {
        await input.transactions.settleNode({
          runId: input.runId,
          nodeId: step.id,
          ...completion,
        });
      } catch (error) { stopAfterFatal(error); }
      settled.set(step.id, completion);
    }
    if (hasFatalError) throw fatalError;
    if (budgetExhausted)
      return { status: "failed", errorCode: "automation_run_duration_exceeded", nodeResults: settled };
    const status = terminalRunStatus([...settled.values()], stopped);
    return {
      status,
      ...(errorCode ? { errorCode } : {}),
      nodeResults: settled,
    };
  } finally {
    clearTimeout(timeout);
    input.abortSignal?.removeEventListener("abort", propagateAbort);
  }
}

function pendingFailureStops(graph: CompiledAutomationGraph, nodeId: string): boolean {
  return graph.steps.find((step) => step.id === nodeId)?.node.onFailure !== "skip";
}
