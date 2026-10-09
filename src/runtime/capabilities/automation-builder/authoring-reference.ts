import type { ToolNormalInvocationOutputChannelRole, ToolNormalInvocationPropertyInput } from "../../../capabilities/normal-invocation/contracts.js";
import type { AgentNode, AutomationTrigger, FolderSource, ToolNode, ValueBinding } from "../../automations/definition-contracts.js";
import { AUTOMATION_DRAFT_BATCH_LIMITS } from "../../automations/draft-batch.js";
import type { DraftMutation } from "../../automations/draft-mutations.js";
import { AUTOMATION_GRAPH_LIMITS, AUTOMATION_OUTPUT_SCHEMA_LIMITS, DEFAULT_AUTOMATION_LIMITS } from "../../automations/limits.js";
import { AUTOMATION_CREATION_RECIPE_LIMITS } from "./creation-recipe.js";
import type { SchedulerScheduleInput } from "../../scheduler/contracts.js";

// These private parser bounds are projected here and checked at both boundaries by reference tests.
const resultSchemaBounds = AUTOMATION_OUTPUT_SCHEMA_LIMITS;
const nodeBounds = { maxTitleLength: 160, maxInstructionLength: 8_192, maxBindings: 64, maxSelectedTools: 64 } as const;
const operation = { toolName: "catalog_tool", operationId: "catalog_operation", contractVersion: 1 } as const;
const tool = { kind: "tool", title: "Read evidence", onFailure: "stop", operation,
  controls: {},
} as const satisfies Omit<ToolNode, "id">;
const agent = { kind: "agent", title: "Analyze evidence", onFailure: "stop",
  modelProfileId: "catalog_model_id", agentMode: "fast", roleInstructions: "Analyze the supplied evidence.",
  prompt: "Return the requested result using only the supplied evidence.", inputs: {}, tools: [],
  result: { kind: "text" },
} as const satisfies Omit<AgentNode, "id">;
const jsonResult = { kind: "json", schema: { type: "object", additionalProperties: false,
  properties: { title: { type: "string", minLength: 1, maxLength: 160 }, ready: { type: "boolean" },
    items: { type: "array", minItems: 0, maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 400 } } },
  required: ["title", "ready", "items"],
} } as const satisfies AgentNode["result"];
const source = { sourceId: "", location: { kind: "runtime_path", path: "/absolute/runtime/inbox" },
  includePatterns: ["*.txt"], excludePatterns: ["output/**", "archive/**"], recursive: false,
  includeExisting: false, mode: "per_file", maxBatchFiles: 100,
} as const satisfies FolderSource;
const schedules = [
  { kind: "timer", delayMs: 60_000 }, { kind: "once", at: "2030-01-01T09:00:00Z" },
  { kind: "interval", everyMs: 3_600_000 },
  { kind: "interval", everyMs: 3_600_000, anchorAt: "2030-01-01T09:00:00Z" },
  { kind: "daily", at: "09:00" }, { kind: "weekly", at: "09:00", weekdays: [1, 3, 5] },
  { kind: "monthly", at: "09:00", dayOfMonth: 1 },
] as const satisfies readonly SchedulerScheduleInput[];
const bindings = {
  literal: { kind: "literal", value: "Exact JSON value" },
  runInput: { kind: "run_input", input: "topic" },
  runFile: { kind: "run_file", fileName: "report.md" },
  sourceFiles: { kind: "source_files" },
  sourceFile: { kind: "source_file", index: 0, field: "snapshot_path" },
  earlierText: { kind: "node_result", nodeId: "$first", select: "text" },
  earlierWholeData: { kind: "node_result", nodeId: "$first", select: "data" },
  earlierData: { kind: "node_result", nodeId: "$analysis", select: "data", pointer: "/title" },
  branches: { kind: "branch_results", parallelNodeId: "$group" },
} as const satisfies Record<string, ValueBinding>;

/** Passive capability grammar; examples are shapes, not a proposed workflow or permission grant. */
export const AUTOMATION_AUTHORING_REFERENCE = {
  kind: "automation_authoring_reference_v1", version: 1, authority: "capability_contract",
  purpose: "Construct or edit an ABot Studio draft using the canonical batch language.",
  applicability: "Only while authoring the draft requested by the user; replace example values with exact selected catalog references and user requirements.",
  presenceEffect: "Does not add user intent or authorize workflow execution, permission grants, publication, activation, or running an automation.",
  permissions: {
    kind: "automation_authoring_permissions_v1", version: 1, authority: "capability_contract",
    purpose: "Interpret catalog fields while authoring the user-requested Studio draft.",
    applicability: "Only the returned catalogScope and selected future workflow operations.",
    presenceEffect: "Reference only; does not authorize draft changes, permission grants, publication, activation or execution.",
    inventory: "Future workflow tools only; excludes Studio editing and scheduling tools. Their absence here does not establish current chat capability availability.",
    grantsPermissions: "False means this read grants no permissions; it does not report the current chat's permissions.",
    granted: "granted and grantedOperations describe the future workflow's existing grant in catalogScope. False does not prevent drafting that operation; execution still requires the applicable grant.",
    permissionMode: "Required permission mode for future workflow execution, not the current chat mode.",
    scope: "pre_draft has no automation identity or saved grant. automation identifies the requested grant scope; it does not prove a draft exists.",
    currentChat: "This catalog does not determine current chat authoring permission. Use the active runtime capability contract and approval policy.",
  },
  bounds: { batch: AUTOMATION_DRAFT_BATCH_LIMITS, recipe: AUTOMATION_CREATION_RECIPE_LIMITS, graph: AUTOMATION_GRAPH_LIMITS },
  createPlanExample: { version: 1, settings: { objective: "Requested workflow outcome" }, steps: [
    { key: "evidence", kind: "tool", title: "Read text evidence", operation },
    { key: "analysis", kind: "agent", title: "Analyze evidence", modelProfileId: "catalog_model_id",
      prompt: "Analyze the supplied evidence.",
      inputs: { evidence: { kind: "node_result", nodeId: "$evidence", select: "text" } } },
  ] },
  creationRules: "New drafts use settings + ordered steps with unique keys and node shapes below. Runtime fills IDs, parents, indices and commands. Defaults: onFailure=stop; tool controls={}; agentMode=fast, roleInstructions='', inputs={}, tools=[], result={kind:'text'}. Override explicitly. Bind earlier results via $key. Parallel: {key,kind:'parallel',branches:[[steps],[steps]]}; branches are ordered and nonempty. Edit with commands; never mix commands and steps.",
  creationCapacity: `Budget ${AUTOMATION_CREATION_RECIPE_LIMITS.compiledCommands}: leaf=1, parallel group=1, nonempty settings=1; total across all branches. With settings, max ${AUTOMATION_CREATION_RECIPE_LIMITS.compiledCommands - 1} flat steps. Oversize rejects atomically: automation_recipe_capacity_exceeded. Expand with later draft edits.`,
  planExample: { version: 1, commands: [{ as: "first", mutation: {
    kind: "add_node", parentSequenceId: "$root", index: 0, nodeWithoutId: tool,
  } }] },
  mutations: {
    add_node: { kind: "add_node", parentSequenceId: "$root", index: 0, nodeWithoutId: agent },
    update_node: { kind: "update_node", nodeId: "$first", patch: { title: "Updated title" } },
    update_definition: { kind: "update_definition", patch: { objective: "Requested workflow outcome" } },
    remove_node: { kind: "remove_node", nodeId: "$first" },
    move_node: { kind: "move_node", nodeId: "$first", parentSequenceId: "$group.branch1", index: 1 },
    wrap_parallel: { kind: "wrap_parallel", nodeIds: ["$first", "$second"] },
  } satisfies Record<DraftMutation["kind"], DraftMutation>,
  transaction: "Commands apply atomically in order; invalid/stale plans save nothing. Create revision 1; apply checks automationId/expectedRevision and increments once. Inspect draft/aliases; re-read uncertain state. operationRefs is full inventory: prepare only needed refs within preparation.operationRefLimit per read; use more reads if needed, then save one edit. Refs imply no access or availability.",
  emptyDrafts: "A metadata-only update_definition command can create an empty draft; removing the final step can reset one. Empty drafts cannot publish or run. To start with only a saved agent: prepare_draft returns savedAgents summaries, create_automation_draft with settings and steps:[], then add_saved_agent using the returned automationId/revision/rootSequenceId and the exact saved agentId/agentRevision. Do not invent a placeholder step or copy an unknown saved-agent configuration.",
  identities: {
    generated: "Never supply a new node id. Optional command as names an add_node or wrap_parallel result. Names: letter then up to 47 letters/digits/_/-, unique within the plan, never root.",
    references: "$root is the existing root sequence. $name refers to an earlier command's as. A wrapped group's branches are $name.branch1, $name.branch2, etc., in original sibling order. Existing nodes use exact IDs from read_draft or the receipt.",
    substitution: "Aliases resolve only identity fields and node_result/branch_results bindings. They never interpolate prompts, paths, or literal values. Aliases from a previous plan must use their receipt's exact IDs.",
    placement: "Indices are zero-based. add_node creates tool or agent nodes only. wrap_parallel needs 2–8 adjacent executable siblings; it creates one sequence per selected step. Insert or move more steps into its branch aliases. Parent must be a sequence.",
  },
  nodes: { tool, agent, operationReference: operation, bounds: nodeBounds,
    payloadExample: { kind: "literal", value: "Payload text" } satisfies ValueBinding,
    toolPolicy: "controls maps operation input names to bindings, never plain values. Supply required controls from the selected operation schema. payload is optional, only for operations declaring a payload; it is one binding, separate from controls.",
    agentPolicy: "Exact modelProfileId from catalog; agentMode=fast|reasoning|deep; onFailure=stop|skip. inputs are named bindings. Placement alone passes no prior output. roleInstructions/prompt assign only this step; the workflow objective is background.",
    selectedToolExamples: [{ operation, usage: "available" }, { operation, usage: "required" }] satisfies AgentNode["tools"],
    toolUsage: "available permits optional use; required demands at least one successful execution of that exact operation. Neither grants permission. Do not mark a conditional action required when a valid outcome may omit it. Do not execute future steps while authoring.",
    result: { text: { kind: "text" }, json: jsonResult },
    resultSchemaBounds,
    resultPolicy: "JSON results must be exactly one object matching the declared flat schema: at most 16 properties, strings at most 4096 characters, arrays at most 64 scalar items. No nested objects, unbounded strings, or string enum schemas. An agent must declare JSON output before its result can use select:data; select:text carries its entire serialized response.",
    schemaPropertyExamples: {
      text: { type: "string", minLength: 0, maxLength: resultSchemaBounds.maxStringLength },
      number: { type: "number", minimum: 0, maximum: 1 },
      integer: { type: "integer", minimum: 0, maximum: 100 },
      boolean: { type: "boolean" },
      array: { type: "array", minItems: 0, maxItems: 8,
        items: { type: "string", minLength: 0, maxLength: 160 } },
    } satisfies Record<string, ToolNormalInvocationPropertyInput>,
    acceptanceExample: [{ field: "ready", equals: true }] satisfies NonNullable<AgentNode["acceptance"]>,
    acceptancePolicy: "Optional acceptance compares required scalar JSON fields to string/number/boolean values of the same type. A mismatch fails the step under onFailure, not a conditional branch. Use [] to clear. No if/else graph construct exists.",
  },
  bindings: { examples: bindings,
    channels: { text: "Saved text.", data: "Separate optional JSON; no implicit Text channel." },
    outputChannels: { content: "Substantive output; may be bounded/summarized.",
      metadata: "IDs, status, counts or receipts; no content body.",
      conditional: "Depends on operation inputs; do not assume content." } satisfies Record<ToolNormalInvocationOutputChannelRole, string>,
    policy: "literal=constants; run_input=definition.inputs; node_result needs prior success. Follow operation.outputChannels; absent=unknown. Whole data needs no pointer. RFC6901 pointers need documented fields (/items/0; ~ as ~0, / as ~1). Never execute steps for output discovery.",
    files: "run_file resolves a new file for each run under its working directory; fileName is one portable filename, no path. source_files requires a configured source and an agent consumer. source_file index selects the frozen batch entry; field=snapshot_path|original_path|version.",
    parallel: "branch_results is agent-only after the referenced parallel join; it supplies each branch's settled tail output/status. A failed/skipped source has no successful node_result for downstream bindings.",
  },
  definition: {
    editableFields: ["title", "objective", "workingDirectory", "trigger", "source", "inputs", "limits"],
    replacement: "A patch merges top-level fields only; inputs, controls, tools, result, acceptance, source, trigger and limits replace their entire field. Keep existing entries when changing part. Limits require all seven keys.",
    workingDirectory: "Omit to preserve the current/default directory; set an absolute path on the Runtime host to override; null removes the override. Never use '.' or another relative path.",
    removals: { definitionPatch: { workingDirectory: null, source: null }, toolNodePatch: { payload: null } },
    triggers: [{ kind: "manual" }, { kind: "schedule", schedule: schedules[4] },
      { kind: "folder", checkEveryMs: 300_000, minimumEligibleFiles: 1 }] satisfies readonly AutomationTrigger[],
    schedules,
    schedulePolicy: "Wrap schedule in {kind:'schedule',schedule:<variant>}. Calendar at is HH:mm; weekdays 0–6 (Sunday=0), dayOfMonth 1–31. timer/interval durations are positive milliseconds; once/anchorAt use ISO instants. Time zone belongs to publication/scheduler host policy, not to trigger or schedule JSON. Unspecified timing remains a user decision.",
    sourceExample: source,
    sourcePolicy: "sourceId:'' generates an ID on update_definition; preserve an existing sourceId to edit it. mode=per_file|batch; source_files/source_file bindings require a source. Exclude generated output/archive paths. IncludeExisting determines first activation's existing-file intake; saving a draft never starts intake.",
    inputsExample: { topic: "User-configured topic" }, limits: DEFAULT_AUTOMATION_LIMITS,
    limitsPolicy: "All limits are positive safe integers. maxConcurrentNodes<=64; stopReportDeadlineMs<=maxRunDurationMs; their sum<=2147483647. Limits are per-run caps except maxRunsPerDay. A run cap is not a per-operation quota.",
  },
} as const;
