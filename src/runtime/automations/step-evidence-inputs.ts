import type { CapabilityJsonValue } from "../orchestration/capability-adapters/result.js";
import { resolveAutomationBinding, type SettledNodeResult } from "./binding-resolution.js";
import type {
  AutomationRevision, ValueBinding,
} from "./definition-contracts.js";
import type { AutomationResultStore } from "./result-store.js";
import type {
  AutomationExecutionRecord, AutomationJournalState,
} from "./storage-records.js";
import { findAutomationStep, type AutomationStepNode } from "./step-evidence-effects.js";
import { compileAutomationGraph } from "./graph-validation.js";
import { projectAutomationBranchResults } from "./branch-result-projection.js";

const INPUT_PREVIEW_CHARACTERS = 2_000;

export type AutomationStepInputEvidence = Readonly<{
  name: string;
  source: string;
  status: "reconstructed" | "metadata" | "unavailable";
  preview?: Readonly<{ value: string; truncated: boolean; totalCharacters: number }>;
}>;

function preview(value: CapabilityJsonValue): AutomationStepInputEvidence["preview"] {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { value: serialized.slice(0, INPUT_PREVIEW_CHARACTERS),
    truncated: serialized.length > INPUT_PREVIEW_CHARACTERS,
    totalCharacters: serialized.length };
}

function sourceLabel(binding: ValueBinding, definition: AutomationRevision): string {
  switch (binding.kind) {
    case "literal": return "Configured value";
    case "run_input": return `Run input · ${binding.input}`;
    case "run_file": return `Run output file · ${binding.fileName}`;
    case "source_files": return "Selected source files";
    case "source_file": return `Selected file ${binding.index + 1} · ${binding.field.replaceAll("_", " ")}`;
    case "node_result": {
      const source = findAutomationStep(definition.body, binding.nodeId);
      return `${source?.title || "Earlier step"} · ${binding.select}${binding.pointer || ""}`;
    }
    case "branch_results": return "Parallel branch results";
  }
}

function bindingsFor(node: AutomationStepNode): readonly (readonly [string, ValueBinding])[] {
  if (node.kind === "agent") return Object.entries(node.inputs)
    .map(([name, binding]) => [`Input · ${name}`, binding] as const);
  return [
    ...Object.entries(node.controls).map(([name, binding]) =>
      [`Control · ${name}`, binding] as const),
    ...(node.payload ? [["Payload", node.payload] as const] : []),
  ];
}

function selectedInputMetadata(state: AutomationJournalState,
  execution: AutomationExecutionRecord | undefined): readonly Readonly<{
    originalPath: string; version: string; sizeBytes: number | null;
  }>[] {
  return (execution?.inputIds ?? []).flatMap((id) => {
    const record = state.inputs.find((item) => item.id === id &&
      item.automationId === execution?.automationId);
    if (!record) return [];
    return [{ originalPath: record.canonicalPath, version: record.contentVersion,
      sizeBytes: record.snapshot?.sizeBytes ?? null }];
  });
}

async function settledOutputs(input: {
  state: AutomationJournalState;
  results: AutomationResultStore;
  runId: string;
  execution: AutomationExecutionRecord | undefined;
  neededIds: ReadonlySet<string>;
}): Promise<ReadonlyMap<string, SettledNodeResult>> {
  const values = new Map<string, SettledNodeResult>();
  for (const step of input.execution?.nodes ?? []) {
    if (!input.neededIds.has(step.nodeId)) continue;
    if (step.status === "pending" || step.status === "ready" || step.status === "running") continue;
    const record = input.state.results.find((item) => item.id === step.resultRef &&
      item.runId === input.runId && item.nodeId === step.nodeId && item.kind === "node_output");
    const saved = record ? await input.results.read(record) : null;
    if (saved !== null && (typeof saved !== "object" || Array.isArray(saved)))
      throw new Error("automation_result_invalid");
    const value = saved as { text?: unknown; data?: unknown } | null;
    values.set(step.nodeId, {
      status: step.status,
      ...(typeof value?.text === "string" ? { text: value.text } : {}),
      ...(value?.data !== undefined ? { data: value.data as CapabilityJsonValue } : {}),
      ...(record ? { resultRef: record.id } : {}),
    });
  }
  return values;
}

function sourceFileEvidence(binding: Extract<ValueBinding, { kind: "source_file" | "source_files" }>,
  metadata: ReturnType<typeof selectedInputMetadata>): Pick<AutomationStepInputEvidence, "status" | "preview"> {
  if (binding.kind === "source_files")
    return { status: "metadata", preview: preview(metadata as unknown as CapabilityJsonValue) };
  const selected = metadata[binding.index];
  if (!selected || binding.field === "snapshot_path") return { status: "unavailable" };
  return { status: "metadata", preview: preview(binding.field === "original_path"
    ? selected.originalPath : selected.version) };
}

export async function readAutomationStepInputs(input: {
  state: AutomationJournalState;
  results: AutomationResultStore;
  runId: string;
  definition: AutomationRevision;
  execution: AutomationExecutionRecord | undefined;
  node: AutomationStepNode;
}): Promise<AutomationStepInputEvidence[]> {
  const bindings = bindingsFor(input.node);
  if (bindings.length === 0) return [];
  const compiled = compileAutomationGraph(input.definition);
  const groups = compiled.ok ? compiled.graph.parallelGroups : [];
  const neededIds = new Set<string>();
  for (const [, binding] of bindings) {
    if (binding.kind === "node_result") neededIds.add(binding.nodeId);
    if (binding.kind === "branch_results")
      groups.find((group) => group.id === binding.parallelNodeId)?.tailNodeIds
        .forEach((id) => neededIds.add(id));
  }
  const nodeResults = await settledOutputs({ ...input, neededIds });
  const branchResults = projectAutomationBranchResults(groups, nodeResults);
  const metadata = selectedInputMetadata(input.state, input.execution);
  return bindings.map(([name, binding]) => {
    const source = sourceLabel(binding, input.definition);
    if (binding.kind === "source_file" || binding.kind === "source_files")
      return { name, source, ...sourceFileEvidence(binding, metadata) };
    const resolved = resolveAutomationBinding(binding, {
      runId: input.runId, runInputs: input.definition.inputs,
      sourceFiles: [], nodeResults, branchResults,
    });
    if (!resolved.ok) return { name, source, status: "unavailable" };
    return { name, source, status: "reconstructed", preview: preview(resolved.value) };
  });
}
