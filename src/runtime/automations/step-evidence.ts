import type { SchedulerService } from "../scheduler/contracts.js";
import type { AutomationPersistence } from "./persistence.js";
import type { AutomationResultStore } from "./result-store.js";
import type { AutomationJournalState, AutomationResultRecord } from "./storage-records.js";
import {
  findAutomationStep, readAutomationStepEffects, type AutomationEffectEvidence,
} from "./step-evidence-effects.js";
import {
  projectAutomationSavedOutcome, projectAutomationSavedOutput,
  type AutomationSavedOutcome, type AutomationSavedOutput,
} from "./step-evidence-output.js";
import { readAutomationStepInputs, type AutomationStepInputEvidence } from "./step-evidence-inputs.js";

export type AutomationStepEvidence = Readonly<{
  runId: string;
  nodeId: string;
  title: string;
  availability: "available" | "expired";
  stepStatus: string;
  output: AutomationSavedOutput | null;
  savedOutcome?: AutomationSavedOutcome;
  inputs: readonly AutomationStepInputEvidence[];
  effects: readonly AutomationEffectEvidence[];
}>;

function requireOutput(state: AutomationJournalState, runId: string, nodeId: string,
  resultId: string): AutomationResultRecord {
  const record = state.results.find((item) => item.id === resultId && item.runId === runId &&
    item.nodeId === nodeId && item.kind === "node_output");
  if (!record) throw new Error("automation_result_ref_invalid");
  return record;
}

export function createAutomationStepEvidenceReader(options: {
  scheduler: Pick<SchedulerService, "getAutomationRun">;
  persistence: AutomationPersistence;
  results: AutomationResultStore;
}) {
  async function get(runId: string, nodeId: string, full = false): Promise<AutomationStepEvidence> {
    const run = await options.scheduler.getAutomationRun(runId);
    if (!run) throw new Error("automation_run_not_found");
    const state = await options.persistence.read();
    const definition = state.definitions.find((item) =>
      item.automationId === run.target.automationId &&
      item.revision === run.target.definitionRevision)?.definition;
    if (!definition) throw new Error("automation_definition_not_found");
    const node = findAutomationStep(definition.body, nodeId);
    if (!node) throw new Error("automation_node_not_found");
    const execution = state.executions.find((item) => item.id === runId &&
      item.automationId === run.target.automationId &&
      item.definitionRevision === run.target.definitionRevision);
    const step = execution?.nodes.find((item) => item.nodeId === nodeId);
    const base = { runId, nodeId, title: node.title, stepStatus: step?.status ?? "pending" };
    if (execution?.detailsExpiredAt)
      return { ...base, availability: "expired", output: null, inputs: [], effects: [] };
    try {
      const saved = step?.resultRef
        ? await options.results.read(requireOutput(state, runId, nodeId, step.resultRef)) : null;
      const output = saved === null ? null : projectAutomationSavedOutput(saved, full);
      const savedOutcome = node.kind === "tool" ? projectAutomationSavedOutcome(saved) : undefined;
      const [effects, inputs] = await Promise.all([
        readAutomationStepEffects({ state, results: options.results, runId, node }),
        readAutomationStepInputs({ state, results: options.results, runId, definition, execution,
          node }),
      ]);
      return { ...base, availability: "available", output, inputs, effects,
        ...(savedOutcome ? { savedOutcome } : {}) };
    } catch (error) {
      // Retention marks expiry before deleting the corresponding bytes.
      const latest = await options.persistence.read();
      if (latest.executions.some((item) => item.id === runId && item.detailsExpiredAt))
        return { ...base, availability: "expired", output: null, inputs: [], effects: [] };
      throw error;
    }
  }
  return { get };
}
