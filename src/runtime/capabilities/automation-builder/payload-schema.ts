import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { AUTOMATION_DRAFT_BATCH_LIMITS } from "../../automations/draft-batch.js";
import { AUTOMATION_GRAPH_LIMITS, DEFAULT_AUTOMATION_LIMITS } from "../../automations/limits.js";
import { AUTOMATION_CREATION_RECIPE_LIMITS } from "./creation-recipe.js";

type AutomationBuilderSchema = Record<string, unknown>;

function object(properties: Record<string, AutomationBuilderSchema>, optional: readonly string[] = []): AutomationBuilderSchema {
  return { type: "object", properties, additionalProperties: false,
    required: Object.keys(properties).filter((name) => !optional.includes(name)) };
}

function text(minLength = 0): AutomationBuilderSchema {
  return { type: "string", ...(minLength ? { minLength } : {}) };
}

function choices(...values: readonly string[]): AutomationBuilderSchema {
  return { type: "string", enum: values };
}

function array(items: AutomationBuilderSchema, maxItems: number, minItems = 0): AutomationBuilderSchema {
  return { type: "array", items, maxItems, ...(minItems ? { minItems } : {}) };
}

function map(values: AutomationBuilderSchema, maxProperties = 64): AutomationBuilderSchema {
  return { type: "object", additionalProperties: values, maxProperties };
}

function nullable(value: AutomationBuilderSchema): AutomationBuilderSchema {
  return { anyOf: [value, { type: "null" }] };
}

const identifier = text(1);
const integer = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const index = { type: "integer", minimum: 0, maximum: AUTOMATION_GRAPH_LIMITS.executableNodes };
const operationReference = object({ toolName: text(1), operationId: text(1), contractVersion: integer });
const operation = { $ref: "#/$defs/operationReference" };
const valueBinding = { anyOf: [
  object({ kind: choices("literal"), value: {} }),
  object({ kind: choices("run_input"), input: text(1) }),
  object({ kind: choices("run_file"), fileName: text(1) }),
  object({ kind: choices("source_files") }),
  object({ kind: choices("source_file"), index: { type: "integer", minimum: 0, maximum: 99 },
    field: choices("snapshot_path", "original_path", "version") }),
  object({ kind: choices("node_result"), nodeId: identifier, select: choices("text") }),
  object({ kind: choices("node_result"), nodeId: identifier, select: choices("data"), pointer: text() }, ["pointer"]),
  object({ kind: choices("branch_results"), parallelNodeId: identifier }),
] };
const binding = { $ref: "#/$defs/valueBinding" };

// The descriptor map is JSON data whose exact flat-schema subset is checked by the graph owner.
// Keeping it opaque also avoids interpreting an output field named maxLength as a provider constraint.
const resultSchema = object({ type: choices("object"), additionalProperties: { type: "boolean", const: false },
  properties: map({ type: "object", additionalProperties: true }, 16), required: array(text(1), 16) });
const result = { anyOf: [object({ kind: choices("text") }), object({ kind: choices("json"), schema: resultSchema })] };
const acceptance = array(object({ field: text(1), equals: { anyOf: [
  { type: "string" }, { type: "number" }, { type: "boolean" },
] } }), 64);
const selectedTools = array(object({ operation, usage: choices("available", "required") }), 64);
const agentTools = { $ref: "#/$defs/selectedTools" };
const savedOrigin = object({ agentId: text(1), revision: integer });
const sharedNode = { title: text(1), onFailure: choices("stop", "skip") };
const toolFields = { operation, controls: map(binding), payload: binding };
const agentFields = { modelProfileId: text(1), agentMode: choices("fast", "reasoning", "deep"),
  roleInstructions: text(), prompt: text(), inputs: map(binding), tools: agentTools,
  result, acceptance, savedAgentOrigin: savedOrigin };
const toolNode = object({ kind: choices("tool"), ...sharedNode, ...toolFields }, ["payload"]);
const agentNode = object({ kind: choices("agent"), ...sharedNode, ...agentFields }, ["acceptance", "savedAgentOrigin"]);
const editableNodeFields = { ...sharedNode, ...toolFields, ...agentFields, payload: nullable(binding) };
const nodePatch = object(editableNodeFields, Object.keys(editableNodeFields));

const schedule = { anyOf: [
  object({ kind: choices("timer"), delayMs: integer }),
  object({ kind: choices("once"), at: text(1) }),
  object({ kind: choices("interval"), everyMs: integer, anchorAt: text(1) }, ["anchorAt"]),
  object({ kind: choices("daily"), at: text(5) }),
  object({ kind: choices("weekly"), at: text(5),
    weekdays: array({ type: "integer", minimum: 0, maximum: 6 }, 7, 1) }),
  object({ kind: choices("monthly"), at: text(5), dayOfMonth: { type: "integer", minimum: 1, maximum: 31 } }),
] };
const trigger = { anyOf: [object({ kind: choices("manual") }), object({ kind: choices("schedule"), schedule }),
  object({ kind: choices("folder"), checkEveryMs: integer,
    minimumEligibleFiles: { type: "integer", minimum: 1, maximum: AUTOMATION_GRAPH_LIMITS.sourceFilesPerBatch } }),
] };
const source = object({ sourceId: text(), location: object({ kind: choices("runtime_path"), path: text() }),
  includePatterns: array(text(), 64), excludePatterns: array(text(), 64),
  recursive: { type: "boolean" }, includeExisting: { type: "boolean" }, mode: choices("per_file", "batch"),
  maxBatchFiles: { type: "integer", minimum: 1, maximum: AUTOMATION_GRAPH_LIMITS.sourceFilesPerBatch } });
const limits = object(Object.fromEntries(Object.keys(DEFAULT_AUTOMATION_LIMITS).map((name) => [name, integer])));
const definitionFields = { title: text(), objective: text(), workingDirectory: nullable(text()),
  trigger, source: nullable(source), inputs: map({}), limits };
const definitionPatch = object(definitionFields, Object.keys(definitionFields));
const addNodeMutation = object({ kind: choices("add_node"), parentSequenceId: identifier, index,
  nodeWithoutId: { anyOf: [toolNode, agentNode] } });
const wrapParallelMutation = object({ kind: choices("wrap_parallel"),
  nodeIds: array(identifier, AUTOMATION_GRAPH_LIMITS.branchesPerGroup, 2) });
const command = { anyOf: [
  object({ as: text(1), mutation: addNodeMutation }, ["as"]),
  object({ mutation: object({ kind: choices("update_node"), nodeId: identifier, patch: nodePatch }) }),
  object({ mutation: object({ kind: choices("update_definition"), patch: { $ref: "#/$defs/definitionPatch" } }) }),
  object({ mutation: object({ kind: choices("remove_node"), nodeId: identifier }) }),
  object({ mutation: object({ kind: choices("move_node"), nodeId: identifier, parentSequenceId: identifier, index }) }),
  object({ as: text(1), mutation: wrapParallelMutation }, ["as"]),
] };
const recipeStep = { anyOf: [
  object({ key: text(1), kind: choices("tool"), ...sharedNode, ...toolFields }, ["onFailure", "controls", "payload"]),
  object({ key: text(1), kind: choices("agent"), ...sharedNode, ...agentFields },
    ["onFailure", "agentMode", "roleInstructions", "inputs", "tools", "result", "acceptance", "savedAgentOrigin"]),
  object({ key: text(1), kind: choices("parallel"), branches:
    array(array({ $ref: "#/properties/steps/items" }, AUTOMATION_CREATION_RECIPE_LIMITS.executableNodes, 1),
      AUTOMATION_GRAPH_LIMITS.branchesPerGroup, 2) }),
] };
const schema = { ...object({ version: { type: "integer", const: 1 },
  commands: array(command, AUTOMATION_DRAFT_BATCH_LIMITS.commands, 1),
  settings: { $ref: "#/$defs/definitionPatch" }, steps: array(recipeStep, AUTOMATION_CREATION_RECIPE_LIMITS.executableNodes),
}, ["commands", "settings", "steps"]), $defs: { valueBinding, definitionPatch, operationReference, selectedTools } };

/** Structural generation grammar. Canonical parsers own route exclusivity, references, bounds and graph semantics. */
export const AUTOMATION_BUILDER_PAYLOAD_FORMAT: ModelGatewayJsonSchemaFormat = Object.freeze({
  type: "json_schema", name: "automation_draft_plan", strict: false, schema,
});
