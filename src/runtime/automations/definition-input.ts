import { parseBoundModelReasoningPreference } from "../../shared/model-reasoning.js";
import { Buffer } from "node:buffer";
import type { AutomationRevision, ValueBinding, WorkflowNode } from "./definition-contracts.js";
import { isAutomationRunFileName } from "./run-file-binding.js";
import { AUTOMATION_GRAPH_LIMITS } from "./limits.js";

const MAX_DEFINITION_BYTES = 128 * 1024;
const MAX_TEXT = 8_192;
const MAX_BINDINGS = 64;
const NODE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const RECORD_ID = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,63}$/u;

function invalid(path: string): never {
  throw new Error(`automation_graph_invalid: ${path}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(path);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid(path);
}

function text(value: unknown, path: string, maximum = MAX_TEXT): void {
  if (typeof value !== "string" || value.length > maximum) invalid(path);
}

function identifier(value: unknown, path: string): void {
  if (typeof value !== "string" || !NODE_ID.test(value)) invalid(path);
}

function recordId(value: unknown, path: string): void {
  if (typeof value !== "string" || !RECORD_ID.test(value)) invalid(path);
}

function positiveInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid(path);
}

function jsonValue(value: unknown, path: string, depth = 0): void {
  if (depth > 12) invalid(path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (value.length > 1_000) invalid(path);
    value.forEach((part, index) => jsonValue(part, `${path}.${index}`, depth + 1));
    return;
  }
  const record = object(value, path);
  if (Object.keys(record).length > MAX_BINDINGS) invalid(path);
  for (const [key, part] of Object.entries(record)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") invalid(path);
    jsonValue(part, `${path}.${key}`, depth + 1);
  }
}

function binding(value: unknown, path: string): asserts value is ValueBinding {
  const input = object(value, path);
  switch (input.kind) {
    case "literal":
      onlyKeys(input, ["kind", "value"], path);
      jsonValue(input.value, `${path}.value`);
      return;
    case "run_input":
      onlyKeys(input, ["kind", "input"], path);
      identifier(input.input, `${path}.input`);
      return;
    case "run_file":
      onlyKeys(input, ["kind", "fileName"], path);
      if (!isAutomationRunFileName(input.fileName)) invalid(`${path}.fileName`);
      return;
    case "source_files":
      onlyKeys(input, ["kind"], path);
      return;
    case "source_file":
      onlyKeys(input, ["kind", "index", "field"], path);
      if (!Number.isSafeInteger(input.index) || Number(input.index) < 0) invalid(`${path}.index`);
      if (!["snapshot_path", "original_path", "version"].includes(String(input.field))) invalid(`${path}.field`);
      return;
    case "node_result":
      onlyKeys(input, ["kind", "nodeId", "select", "pointer"], path);
      identifier(input.nodeId, `${path}.nodeId`);
      if (input.select !== "text" && input.select !== "data") invalid(`${path}.select`);
      if (input.pointer !== undefined) text(input.pointer, `${path}.pointer`, 512);
      return;
    case "branch_results":
      onlyKeys(input, ["kind", "parallelNodeId"], path);
      identifier(input.parallelNodeId, `${path}.parallelNodeId`);
      return;
    default:
      invalid(`${path}.kind`);
  }
}

function bindings(value: unknown, path: string): void {
  const entries = Object.entries(object(value, path));
  if (entries.length > MAX_BINDINGS) invalid(path);
  for (const [name, entry] of entries) {
    identifier(name, `${path}.name`);
    binding(entry, `${path}.${name}`);
  }
}

function operation(value: unknown, path: string): void {
  const input = object(value, path);
  onlyKeys(input, ["toolName", "operationId", "contractVersion"], path);
  text(input.toolName, `${path}.toolName`, 64);
  text(input.operationId, `${path}.operationId`, 64);
  positiveInteger(input.contractVersion, `${path}.contractVersion`);
}

function node(value: unknown, path: string, depth: number): asserts value is WorkflowNode {
  if (depth > AUTOMATION_GRAPH_LIMITS.nestingDepth * 2 + 1) invalid(path);
  const input = object(value, path);
  identifier(input.id, `${path}.id`);
  if (input.kind === "sequence") {
    onlyKeys(input, ["kind", "id", "children"], path);
    if (!Array.isArray(input.children) || input.children.length > AUTOMATION_GRAPH_LIMITS.executableNodes) invalid(`${path}.children`);
    input.children.forEach((child, index) => node(child, `${path}.children.${index}`, depth + 1));
    return;
  }
  if (input.kind === "parallel") {
    onlyKeys(input, ["kind", "id", "branches"], path);
    if (!Array.isArray(input.branches) || input.branches.length > AUTOMATION_GRAPH_LIMITS.branchesPerGroup) invalid(`${path}.branches`);
    input.branches.forEach((branch, index) => {
      if (object(branch, `${path}.branches.${index}`).kind !== "sequence") invalid(`${path}.branches.${index}`);
      node(branch, `${path}.branches.${index}`, depth + 1);
    });
    return;
  }
  text(input.title, `${path}.title`, 160);
  if (input.onFailure !== "stop" && input.onFailure !== "skip") invalid(`${path}.onFailure`);
  if (input.kind === "tool") {
    onlyKeys(input, ["kind", "id", "title", "onFailure", "operation", "controls", "payload"], path);
    operation(input.operation, `${path}.operation`);
    bindings(input.controls, `${path}.controls`);
    if (input.payload !== undefined) binding(input.payload, `${path}.payload`);
    return;
  }
  if (input.kind !== "agent") invalid(`${path}.kind`);
  onlyKeys(input, ["kind", "id", "title", "onFailure", "modelProfileId", "agentMode", "reasoningPreference", "roleInstructions", "prompt", "inputs", "tools", "result", "acceptance", "savedAgentOrigin"], path);
  text(input.modelProfileId, `${path}.modelProfileId`, 128);
  parseBoundModelReasoningPreference(input.reasoningPreference, String(input.modelProfileId));
  if (!["fast", "reasoning", "deep"].includes(String(input.agentMode))) invalid(`${path}.agentMode`);
  text(input.roleInstructions, `${path}.roleInstructions`);
  text(input.prompt, `${path}.prompt`);
  bindings(input.inputs, `${path}.inputs`);
  if (!Array.isArray(input.tools) || input.tools.length > MAX_BINDINGS) invalid(`${path}.tools`);
  input.tools.forEach((entry, index) => {
    const selected = object(entry, `${path}.tools.${index}`);
    onlyKeys(selected, ["operation", "usage"], `${path}.tools.${index}`);
    operation(selected.operation, `${path}.tools.${index}.operation`);
    if (selected.usage !== "available" && selected.usage !== "required") invalid(`${path}.tools.${index}.usage`);
  });
  const result = object(input.result, `${path}.result`);
  if (result.kind === "text") onlyKeys(result, ["kind"], `${path}.result`);
  else if (result.kind === "json") {
    onlyKeys(result, ["kind", "schema"], `${path}.result`);
    const schema = object(result.schema, `${path}.result.schema`);
    onlyKeys(schema, ["type", "additionalProperties", "properties", "required"], `${path}.result.schema`);
    if (schema.type !== "object" || schema.additionalProperties !== false) invalid(`${path}.result.schema`);
    if (!Array.isArray(schema.required) || !schema.required.every((name) => typeof name === "string")) invalid(`${path}.result.schema.required`);
    const properties = object(schema.properties, `${path}.result.schema.properties`);
    if (Object.keys(properties).length > MAX_BINDINGS) invalid(`${path}.result.schema.properties`);
    for (const [name, property] of Object.entries(properties)) {
      identifier(name, `${path}.result.schema.properties`);
      object(property, `${path}.result.schema.properties.${name}`);
    }
  } else invalid(`${path}.result.kind`);
  if (input.acceptance !== undefined) {
    if (!Array.isArray(input.acceptance) || input.acceptance.length > MAX_BINDINGS) invalid(`${path}.acceptance`);
    input.acceptance.forEach((entry, index) => {
      const check = object(entry, `${path}.acceptance.${index}`);
      onlyKeys(check, ["field", "equals"], `${path}.acceptance.${index}`);
      identifier(check.field, `${path}.acceptance.${index}.field`);
      if (!["string", "number", "boolean"].includes(typeof check.equals)) invalid(`${path}.acceptance.${index}.equals`);
    });
  }
  if (input.savedAgentOrigin !== undefined) {
    const origin = object(input.savedAgentOrigin, `${path}.savedAgentOrigin`);
    onlyKeys(origin, ["agentId", "revision"], `${path}.savedAgentOrigin`);
    recordId(origin.agentId, `${path}.savedAgentOrigin.agentId`);
    positiveInteger(origin.revision, `${path}.savedAgentOrigin.revision`);
  }
}

function trigger(value: unknown): void {
  const input = object(value, "trigger");
  if (input.kind === "manual") {
    onlyKeys(input, ["kind"], "trigger");
    return;
  }
  if (input.kind === "schedule") {
    onlyKeys(input, ["kind", "schedule"], "trigger");
    object(input.schedule, "trigger.schedule");
    return;
  }
  if (input.kind !== "folder") invalid("trigger.kind");
  onlyKeys(input, ["kind", "checkEveryMs", "minimumEligibleFiles"], "trigger");
  positiveInteger(input.checkEveryMs, "trigger.checkEveryMs");
  positiveInteger(input.minimumEligibleFiles, "trigger.minimumEligibleFiles");
}

function source(value: unknown): void {
  const input = object(value, "source");
  onlyKeys(input, ["sourceId", "location", "includePatterns", "excludePatterns", "recursive", "includeExisting", "mode", "maxBatchFiles"], "source");
  recordId(input.sourceId, "source.sourceId");
  const location = object(input.location, "source.location");
  onlyKeys(location, ["kind", "path"], "source.location");
  if (location.kind !== "runtime_path") invalid("source.location.kind");
  text(location.path, "source.location.path", 1_024);
  for (const name of ["includePatterns", "excludePatterns"] as const) {
    const patterns = input[name];
    if (!Array.isArray(patterns) || patterns.length > 64) invalid(`source.${name}`);
    patterns.forEach((pattern, index) => text(pattern, `source.${name}.${index}`, 256));
  }
  if (typeof input.recursive !== "boolean" || typeof input.includeExisting !== "boolean") invalid("source.flags");
  if (input.mode !== "per_file" && input.mode !== "batch") invalid("source.mode");
  positiveInteger(input.maxBatchFiles, "source.maxBatchFiles");
}

/** Parse untrusted editor/authoring JSON before the graph walker touches it. */
export function parseAutomationDefinition(value: unknown): AutomationRevision {
  const input = object(value, "definition");
  let serialized: string;
  try { serialized = JSON.stringify(input); } catch { invalid("definition"); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_DEFINITION_BYTES) invalid("definition.size");
  onlyKeys(input, ["schemaVersion", "automationId", "revision", "title", "objective", "workingDirectory", "trigger", "source", "inputs", "body", "limits"], "definition");
  if (input.schemaVersion !== 1) invalid("schemaVersion");
  recordId(input.automationId, "automationId");
  positiveInteger(input.revision, "revision");
  text(input.title, "title", 160);
  text(input.objective, "objective");
  if (input.workingDirectory !== undefined) text(input.workingDirectory, "workingDirectory", 1_024);
  trigger(input.trigger);
  if (input.source !== undefined) source(input.source);
  jsonValue(input.inputs, "inputs");
  if (Array.isArray(input.inputs) || input.inputs === null || typeof input.inputs !== "object") invalid("inputs");
  node(input.body, "body", 0);
  if (object(input.body, "body").kind !== "sequence") invalid("body.kind");
  const limits = object(input.limits, "limits");
  onlyKeys(limits, ["maxConcurrentNodes", "maxModelCallsPerRun", "maxToolCallsPerRun", "maxRunDurationMs", "maxRunsPerDay", "maxStoredArtifactBytes", "stopReportDeadlineMs"], "limits");
  for (const value of Object.values(limits)) positiveInteger(value, "limits");
  if (Object.keys(limits).length !== 7) invalid("limits");
  return JSON.parse(serialized) as AutomationRevision;
}
