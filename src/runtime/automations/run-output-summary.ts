import type { AutomationRevision } from "./definition-contracts.js";
import { compileAutomationGraph, type CompiledAutomationStep } from "./graph-validation.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationResultStore } from "./result-store.js";
import { projectAutomationSavedOutput, type AutomationSavedOutput } from "./step-evidence-output.js";
import type { AutomationJournalState, AutomationNodeStateRecord } from "./storage-records.js";

const MAX_RUN_OUTPUTS = 4;

export type AutomationRunOutputEntry = Readonly<{
  nodeId: string;
  title: string;
  stepStatus: AutomationNodeStateRecord["status"];
  availability: "available" | "expired" | "unavailable";
  output: AutomationSavedOutput | null;
  errorCode?: string;
}>;

export type AutomationRunOutputSummary = Readonly<{
  entries: readonly AutomationRunOutputEntry[];
  omitted: number;
}>;

function findOwnedExecution(state: AutomationJournalState, runId: string,
  definition: AutomationRevision) {
  return state.executions.find((item) => item.id === runId &&
    item.automationId === definition.automationId &&
    item.definitionRevision === definition.revision);
}

function terminalOutputSteps(definition: AutomationRevision): readonly CompiledAutomationStep[] {
  const compiled = compileAutomationGraph(definition);
  if (!compiled.ok) return [];
  const predecessors = new Set(compiled.graph.steps.flatMap((step) => step.dependsOn));
  return compiled.graph.steps.filter((step) => !predecessors.has(step.id));
}

/** A transient preview of terminal producers, never another persisted report or outcome. */
export async function readAutomationRunOutputSummary(options: {
  state: AutomationJournalState;
  runId: string;
  definition: AutomationRevision;
  results: Pick<AutomationResultStore, "read">;
  persistence: Pick<AutomationPersistence, "read">;
}): Promise<AutomationRunOutputSummary> {
  const { state, runId, definition } = options;
  const execution = findOwnedExecution(state, runId, definition);
  const terminalSteps = terminalOutputSteps(definition);
  let expiryRead: Promise<boolean> | undefined;
  function detailsExpiredDuringRead(): Promise<boolean> {
    expiryRead ??= options.persistence.read().then((latest) =>
      Boolean(findOwnedExecution(latest, runId, definition)?.detailsExpiredAt), () => false);
    return expiryRead;
  }

  async function readEntry(step: CompiledAutomationStep): Promise<AutomationRunOutputEntry> {
    const settled = execution?.nodes.find((item) => item.nodeId === step.id);
    const base = {
      nodeId: step.id, title: step.node.title, stepStatus: settled?.status ?? "pending",
      ...(settled?.errorCode ? { errorCode: settled.errorCode } : {}),
    } as const;
    if (execution?.detailsExpiredAt)
      return { ...base, availability: "expired", output: null };
    if (!settled?.resultRef)
      return { ...base, availability: "unavailable", output: null };
    const record = state.results.find((item) => item.id === settled.resultRef &&
      item.runId === runId && item.nodeId === step.id && item.kind === "node_output");
    if (!record) return { ...base, availability: "unavailable", output: null };
    try {
      const saved = await options.results.read(record);
      const output = projectAutomationSavedOutput(saved, false);
      return { ...base, availability: "available", output };
    } catch {
      // Retention publishes expiry before deleting bytes. Missing/corrupt output
      // must not hide the independently retained compact report.
      const expired = await detailsExpiredDuringRead();
      return { ...base, availability: expired ? "expired" : "unavailable", output: null };
    }
  }

  const entries = await Promise.all(terminalSteps.slice(0, MAX_RUN_OUTPUTS).map(readEntry));
  return { entries, omitted: Math.max(0, terminalSteps.length - MAX_RUN_OUTPUTS) };
}
