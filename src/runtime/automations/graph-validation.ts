import { TOOL_NORMAL_INVOCATION_VERSION, type ToolNormalInvocationScalarInput } from "../../capabilities/normal-invocation/contracts.js";
import { parseToolNormalInvocationContract } from "../../capabilities/normal-invocation/validator.js";
import type {
  AgentNode,
  AutomationOutputSchema,
  AutomationRevision,
  OperationRef,
  ParallelNode,
  SequenceNode,
  ToolNode,
  ValueBinding,
  WorkflowNode,
} from "./definition-contracts.js";
import { AUTOMATION_GRAPH_LIMITS, AUTOMATION_OUTPUT_SCHEMA_LIMITS, validateAutomationLimits } from "./limits.js";
import { isAutomationRunFileName } from "./run-file-binding.js";

export type AutomationGraphIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type CompiledAutomationStep = Readonly<{
  id: string;
  node: AgentNode | ToolNode;
  dependsOn: readonly string[];
}>;

export type CompiledParallelGroup = Readonly<{
  id: string;
  branches: readonly (readonly string[])[];
  tailNodeIds: readonly string[];
}>;

export type CompiledAutomationGraph = Readonly<{
  steps: readonly CompiledAutomationStep[];
  parallelGroups: readonly CompiledParallelGroup[];
}>;

export type AutomationGraphCompilation =
  | Readonly<{ ok: true; graph: CompiledAutomationGraph }>
  | Readonly<{ ok: false; issues: readonly AutomationGraphIssue[] }>;

type AvailableResults = Readonly<{
  nodeIds: ReadonlySet<string>;
  parallelIds: ReadonlySet<string>;
  tailNodeIds: ReadonlySet<string>;
}>;

type GraphWalk = {
  definition: AutomationRevision;
  issues: AutomationGraphIssue[];
  seenIds: Set<string>;
  nodesById: Map<string, AgentNode | ToolNode>;
  executableCount: number;
  steps: CompiledAutomationStep[];
  parallelGroups: CompiledParallelGroup[];
};

const NODE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const OPERATION_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,63}$/u;
const FORBIDDEN_POINTER_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function issue(walk: GraphWalk, code: string, path: string, message: string): void {
  walk.issues.push({ code, path, message });
}

function isValidNodeIdentity(walk: GraphWalk, node: WorkflowNode, path: string): boolean {
  if (!NODE_ID.test(node.id)) {
    issue(walk, "automation_node_id_invalid", path, "Node ID must be a bounded stable identifier.");
    return false;
  }
  if (walk.seenIds.has(node.id)) {
    issue(walk, "automation_node_id_duplicate", path, `Node ID ${node.id} is duplicated.`);
    return false;
  }
  walk.seenIds.add(node.id);
  return true;
}

function isValidResultPointer(pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  for (const segment of pointer.slice(1).split("/")) {
    if (/~(?![01])/u.test(segment)) return false;
    const decoded = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (FORBIDDEN_POINTER_KEYS.has(decoded)) return false;
  }
  return true;
}

function validateOperationRef(walk: GraphWalk, ref: OperationRef, path: string): void {
  if (!OPERATION_ID.test(ref.toolName) || !OPERATION_ID.test(ref.operationId)) {
    issue(walk, "automation_operation_invalid", path, "Select a bounded tool and operation ID.");
  }
  if (ref.contractVersion !== TOOL_NORMAL_INVOCATION_VERSION) {
    issue(walk, "automation_contract_changed", path, "The operation contract version is unsupported.");
  }
}

function validateBinding(
  walk: GraphWalk,
  binding: ValueBinding,
  path: string,
  available: AvailableResults,
  consumer: "agent" | "tool",
): void {
  switch (binding.kind) {
    case "literal":
      return;
    case "run_file":
      if (!isAutomationRunFileName(binding.fileName))
        issue(walk, "automation_run_file_invalid", path, "Use a portable file name without a directory path.");
      return;
    case "run_input":
      if (!Object.hasOwn(walk.definition.inputs, binding.input)) {
        issue(walk, "automation_dependency_missing", path, `Run input ${binding.input} is not defined.`);
      }
      return;
    case "source_files":
      if (consumer !== "agent" || !walk.definition.source) {
        issue(walk, "automation_dependency_missing", path, "Source file groups require an Agent and a configured source.");
      }
      return;
    case "source_file":
      if (!walk.definition.source) {
        issue(walk, "automation_dependency_missing", path, "A source file requires a configured source.");
        return;
      }
      if (!Number.isSafeInteger(binding.index) || binding.index < 0 ||
          binding.index >= walk.definition.source.maxBatchFiles ||
          (walk.definition.source.mode === "per_file" && binding.index !== 0)) {
        issue(walk, "automation_source_index_invalid", path, "Source index is outside the selected run input.");
      }
      return;
    case "node_result": {
      if (!available.nodeIds.has(binding.nodeId)) {
        issue(walk, "automation_dependency_missing", path, `Node ${binding.nodeId} has not settled before this step.`);
        return;
      }
      const producer = walk.nodesById.get(binding.nodeId);
      if (binding.select === "data" && producer?.kind === "agent" && producer.result.kind !== "json") {
        issue(walk, "automation_dependency_missing", path, "The selected Agent does not declare JSON output.");
      }
      if (binding.pointer !== undefined &&
          (binding.select !== "data" || !isValidResultPointer(binding.pointer))) {
        issue(walk, "automation_output_pointer_invalid", path, "Use a safe JSON pointer into declared data output.");
      }
      return;
    }
    case "branch_results":
      if (consumer !== "agent" || !available.parallelIds.has(binding.parallelNodeId)) {
        issue(walk, "automation_dependency_missing", path, "Branch results are available to an Agent only after their join.");
      }
      return;
  }
}

function validateNodeBindings(
  walk: GraphWalk,
  node: AgentNode | ToolNode,
  path: string,
  available: AvailableResults,
): void {
  if (node.kind === "tool") {
    validateOperationRef(walk, node.operation, `${path}.operation`);
    for (const [name, binding] of Object.entries(node.controls)) {
      validateBinding(walk, binding, `${path}.controls.${name}`, available, "tool");
    }
    if (node.payload) validateBinding(walk, node.payload, `${path}.payload`, available, "tool");
    return;
  }
  for (const [name, binding] of Object.entries(node.inputs)) {
    validateBinding(walk, binding, `${path}.inputs.${name}`, available, "agent");
  }
  if (!node.modelProfileId.trim()) {
    issue(walk, "automation_model_unavailable", `${path}.modelProfileId`, "Select a model for this Agent.");
  }
  for (const [index, selected] of node.tools.entries()) {
    validateOperationRef(walk, selected.operation, `${path}.tools.${index}`);
  }
  validateAgentOutput(walk, node, path);
}

function validateAgentOutput(walk: GraphWalk, node: AgentNode, path: string): void {
  if (node.result.kind !== "json") {
    for (const [index] of (node.acceptance ?? []).entries()) {
      issue(walk, "automation_acceptance_invalid", `${path}.acceptance.${index}`, "Acceptance requires declared JSON output.");
    }
    return;
  }
  try {
    parseToolNormalInvocationContract("automation_result", {
      version: TOOL_NORMAL_INVOCATION_VERSION,
      operations: [{
        operationId: "result",
        summary: "Automation Agent result",
        input: node.result.schema,
        effect: "read_only",
        approval: "request_policy",
      }],
    });
  } catch (error) {
    issue(walk, "automation_output_schema_invalid", `${path}.result.schema`, String(error));
    return;
  }
  for (const [name, property] of Object.entries(node.result.schema.properties)) {
    const scalar = property.type === "array" ? property.items : property;
    if (!hasBoundedAutomationOutputScalar(scalar)) {
      issue(walk, "automation_output_schema_invalid", `${path}.result.schema.${name}`, `String outputs must be bounded to at most ${AUTOMATION_OUTPUT_SCHEMA_LIMITS.maxStringLength} characters.`);
    }
  }
  for (const [index, check] of (node.acceptance ?? []).entries()) {
    if (!isDeclaredScalarAcceptance(node.result.schema, check)) {
      issue(walk, "automation_acceptance_invalid", `${path}.acceptance.${index}`, "Acceptance must compare a required scalar JSON result field.");
    }
  }
}

function hasBoundedAutomationOutputScalar(scalar: ToolNormalInvocationScalarInput): boolean {
  if (scalar.type !== "string") return true;
  if (!("maxLength" in scalar)) return false;
  return scalar.maxLength <= AUTOMATION_OUTPUT_SCHEMA_LIMITS.maxStringLength;
}

function isDeclaredScalarAcceptance(
  schema: AutomationOutputSchema,
  check: { field: string; equals: string | number | boolean },
): boolean {
  const field = schema.properties[check.field];
  if (!schema.required.includes(check.field) || !field) return false;
  if (field.type === "array") return false;
  if (field.type === "integer") return typeof check.equals === "number" && Number.isSafeInteger(check.equals);
  return field.type === typeof check.equals;
}

function visitSequence(
  walk: GraphWalk,
  sequence: SequenceNode,
  available: AvailableResults,
  depth: number,
  path: string,
): AvailableResults {
  isValidNodeIdentity(walk, sequence, path);
  if (depth > AUTOMATION_GRAPH_LIMITS.nestingDepth) {
    issue(walk, "automation_graph_too_deep", path, "The graph exceeds the nesting limit.");
    return available;
  }
  let current = available;
  for (const [index, child] of sequence.children.entries()) {
    current = visitNode(walk, child, current, depth + 1, `${path}.children.${index}`);
  }
  return current;
}

function visitParallel(
  walk: GraphWalk,
  parallel: ParallelNode,
  available: AvailableResults,
  depth: number,
  path: string,
): AvailableResults {
  isValidNodeIdentity(walk, parallel, path);
  if (parallel.branches.length < 2 || parallel.branches.length > AUTOMATION_GRAPH_LIMITS.branchesPerGroup) {
    issue(walk, "automation_parallel_invalid", path, "A parallel group needs 2–8 branches.");
  }
  const mergedNodes = new Set(available.nodeIds);
  const mergedGroups = new Set(available.parallelIds);
  const mergedTails = new Set<string>();
  const branches: string[][] = [];
  for (const [index, branch] of parallel.branches.entries()) {
    const before = walk.steps.length;
    const settled = visitSequence(walk, branch, available, depth + 1, `${path}.branches.${index}`);
    branches.push(walk.steps.slice(before).map((step) => step.id));
    for (const id of settled.nodeIds) mergedNodes.add(id);
    for (const id of settled.parallelIds) mergedGroups.add(id);
    for (const id of settled.tailNodeIds) mergedTails.add(id);
  }
  mergedGroups.add(parallel.id);
  walk.parallelGroups.push({ id: parallel.id, branches, tailNodeIds: [...mergedTails] });
  return { nodeIds: mergedNodes, parallelIds: mergedGroups, tailNodeIds: mergedTails };
}

function visitNode(
  walk: GraphWalk,
  node: WorkflowNode,
  available: AvailableResults,
  depth: number,
  path: string,
): AvailableResults {
  if (node.kind === "sequence") return visitSequence(walk, node, available, depth, path);
  if (node.kind === "parallel") return visitParallel(walk, node, available, depth, path);
  isValidNodeIdentity(walk, node, path);
  walk.executableCount += 1;
  if (walk.executableCount > AUTOMATION_GRAPH_LIMITS.executableNodes) {
    issue(walk, "automation_graph_too_large", path, "The graph exceeds the executable node limit.");
  }
  if (node.title.trim().length === 0 || node.title.length > 160) {
    issue(walk, "automation_node_title_invalid", path, "Give the step a bounded title.");
  }
  validateNodeBindings(walk, node, path, available);
  walk.nodesById.set(node.id, node);
  walk.steps.push({ id: node.id, node, dependsOn: [...available.tailNodeIds] });
  return {
    nodeIds: new Set([...available.nodeIds, node.id]),
    parallelIds: available.parallelIds,
    tailNodeIds: new Set([node.id]),
  };
}

function inspectAutomationGraph(definition: AutomationRevision): GraphWalk {
  const walk: GraphWalk = {
    definition, issues: [], seenIds: new Set(), nodesById: new Map(), executableCount: 0,
    steps: [], parallelGroups: [],
  };
  for (const message of validateAutomationLimits(definition.limits)) {
    issue(walk, "automation_limits_invalid", "limits", message);
  }
  if (definition.trigger.kind === "folder" && !definition.source) {
    issue(walk, "automation_source_unavailable", "source", "A folder trigger requires a source.");
  }
  if (definition.source) {
    if (!Number.isSafeInteger(definition.source.maxBatchFiles) || definition.source.maxBatchFiles < 1 ||
        definition.source.maxBatchFiles > AUTOMATION_GRAPH_LIMITS.sourceFilesPerBatch) {
      issue(walk, "automation_source_limit_invalid", "source.maxBatchFiles", "Choose 1–100 files per captured run.");
    }
    if (definition.trigger.kind === "folder" &&
        (!Number.isSafeInteger(definition.trigger.minimumEligibleFiles) ||
         definition.trigger.minimumEligibleFiles < 1 ||
         definition.trigger.minimumEligibleFiles > definition.source.maxBatchFiles)) {
      issue(walk, "automation_source_threshold_invalid", "trigger.minimumEligibleFiles", "The threshold must fit the captured batch.");
    }
    if (definition.source.mode === "per_file" && definition.trigger.kind === "folder" &&
        definition.trigger.minimumEligibleFiles !== 1) {
      issue(walk, "automation_source_threshold_invalid", "trigger.minimumEligibleFiles",
        "Per-file workflows trigger for one eligible file at a time.");
    }
  }
  visitSequence(walk, definition.body, {
    nodeIds: new Set(), parallelIds: new Set(), tailNodeIds: new Set(),
  }, 0, "body");
  if (walk.executableCount === 0) {
    issue(walk, "automation_graph_empty", "body", "Add at least one Tool or Agent step.");
  }
  return walk;
}

export function validateAutomationGraph(definition: AutomationRevision): readonly AutomationGraphIssue[] {
  return inspectAutomationGraph(definition).issues;
}

export function compileAutomationGraph(definition: AutomationRevision): AutomationGraphCompilation {
  const inspected = inspectAutomationGraph(definition);
  if (inspected.issues.length > 0) return { ok: false, issues: inspected.issues };
  return {
    ok: true,
    graph: { steps: inspected.steps, parallelGroups: inspected.parallelGroups },
  };
}
