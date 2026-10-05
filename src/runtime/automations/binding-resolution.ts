import type { CapabilityJsonValue } from "../orchestration/capability-adapters/result.js";
import type { SourceFileSnapshot, ValueBinding } from "./definition-contracts.js";
import { automationRunFilePath } from "./run-file-binding.js";

export type SettledNodeResult = Readonly<{
  status: "succeeded" | "skipped" | "failed" | "cancelled" | "interrupted";
  text?: string;
  data?: CapabilityJsonValue;
  resultRef?: string;
}>;

export type BranchResult = Readonly<{
  nodeId: string;
  status: SettledNodeResult["status"];
  resultRef?: string;
}>;

export type AutomationBindingContext = Readonly<{
  runId?: string;
  runInputs: Readonly<Record<string, CapabilityJsonValue>>;
  sourceFiles: readonly SourceFileSnapshot[];
  nodeResults: ReadonlyMap<string, SettledNodeResult>;
  branchResults: ReadonlyMap<string, readonly BranchResult[]>;
}>;

export type AutomationBindingResolution =
  | Readonly<{ ok: true; value: CapabilityJsonValue }>
  | Readonly<{ ok: false; code: "automation_dependency_missing" | "automation_output_pointer_invalid" }>;

const MISSING: AutomationBindingResolution = Object.freeze({
  ok: false,
  code: "automation_dependency_missing",
});

function resolvePointer(value: CapabilityJsonValue, pointer: string): AutomationBindingResolution {
  if (!pointer.startsWith("/")) {
    return { ok: false, code: "automation_output_pointer_invalid" };
  }
  let selected = value;
  for (const segment of pointer.slice(1).split("/")) {
    if (/~(?![01])/u.test(segment)) {
      return { ok: false, code: "automation_output_pointer_invalid" };
    }
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      return { ok: false, code: "automation_output_pointer_invalid" };
    }
    if (Array.isArray(selected)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(key)) return MISSING;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= selected.length) return MISSING;
      selected = selected[index]!;
      continue;
    }
    if (typeof selected !== "object" || selected === null || !Object.hasOwn(selected, key)) {
      return MISSING;
    }
    selected = (selected as Record<string, CapabilityJsonValue>)[key]!;
  }
  return { ok: true, value: selected };
}

function sourceFileValue(file: SourceFileSnapshot): CapabilityJsonValue {
  return {
    inputId: file.inputId,
    sourceId: file.sourceId,
    originalPath: file.originalPath,
    snapshotPath: file.snapshotPath,
    version: file.version,
    sizeBytes: file.sizeBytes,
  };
}

function selectedSourceField(
  file: SourceFileSnapshot,
  field: "snapshot_path" | "original_path" | "version",
): string {
  switch (field) {
    case "snapshot_path": return file.snapshotPath;
    case "original_path": return file.originalPath;
    case "version": return file.version;
  }
}

function resolveSettledNodeResult(
  binding: Extract<ValueBinding, { kind: "node_result" }>,
  context: AutomationBindingContext,
): AutomationBindingResolution {
  const result = context.nodeResults.get(binding.nodeId);
  if (result?.status !== "succeeded") return MISSING;
  const value = binding.select === "text" ? result.text : result.data;
  if (value === undefined) return MISSING;
  if (binding.pointer === undefined) return { ok: true, value };
  if (binding.select !== "data") {
    return { ok: false, code: "automation_output_pointer_invalid" };
  }
  return resolvePointer(value, binding.pointer);
}

function resolveParallelResults(
  parallelNodeId: string,
  context: AutomationBindingContext,
): AutomationBindingResolution {
  const branches = context.branchResults.get(parallelNodeId);
  if (!branches) return MISSING;
  const values: CapabilityJsonValue[] = [];
  for (const branch of branches) {
    if (branch.status !== "succeeded") {
      values.push({ ...branch });
      continue;
    }
    const result = context.nodeResults.get(branch.nodeId);
    if (result?.status !== "succeeded") return MISSING;
    const hasMaterializedOutput = result.text !== undefined || result.data !== undefined;
    if (!hasMaterializedOutput) return MISSING;
    values.push({
      ...branch,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(result.data !== undefined ? { data: result.data } : {}),
    });
  }
  return { ok: true, value: values };
}

export function resolveAutomationBinding(
  binding: ValueBinding,
  context: AutomationBindingContext,
): AutomationBindingResolution {
  switch (binding.kind) {
    case "literal":
      return { ok: true, value: binding.value };
    case "run_input":
      return Object.hasOwn(context.runInputs, binding.input)
        ? { ok: true, value: context.runInputs[binding.input]! }
        : MISSING;
    case "run_file": {
      const value = automationRunFilePath(context.runId, binding.fileName);
      return value === null ? MISSING : { ok: true, value };
    }
    case "source_files":
      return { ok: true, value: context.sourceFiles.map(sourceFileValue) };
    case "source_file": {
      const file = context.sourceFiles[binding.index];
      if (!file) return MISSING;
      return { ok: true, value: selectedSourceField(file, binding.field) };
    }
    case "node_result":
      return resolveSettledNodeResult(binding, context);
    case "branch_results":
      return resolveParallelResults(binding.parallelNodeId, context);
  }
}
