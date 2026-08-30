import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { isToolCatalogGroupId } from "../../../capabilities/tool-types.js";
import { createStructuredDecisionEnvelopeSchema } from "../../model/structured-decision-envelope.js";
import {
  CAPABILITY_COUNT_MAX,
  CAPABILITY_INTENT_MAX_LENGTH,
  EXECUTION_WORKING_DIRECTORY_MAX_LENGTH,
  EXECUTION_WORKING_DIRECTORY_PATTERN,
  canOfferCapabilityBatchSelection,
  normalizeCapabilityDescriptor,
  normalizeCapabilityControlsSchema,
  partitionCapabilityControlsSchema,
  type CapabilityControl,
  type CapabilityControlsPartition,
  type CapabilityControlsSchema,
  type CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";
import {
  EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX,
  EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH,
  EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX,
  EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH,
  EXECUTION_AGENT_RESPONSE_MAX_LENGTH,
  EXECUTION_AGENT_TITLE_MAX_LENGTH,
  type ExecutionAgentDecisionContractOptions,
} from "./contracts.js";
import {
  executionOperationObjectiveSchema,
  requiresExecutionOperationObjective,
} from "./capability-invocation-contract.js";

export type PreparedExecutionAgentCapability = Readonly<{
  capabilityId: string;
  effect: CapabilityDescriptor["effect"];
  partition: CapabilityControlsPartition;
}>;

export type PreparedExecutionAgentDecisionContract = Readonly<{
  capabilities: readonly PreparedExecutionAgentCapability[];
  observationCapabilities: readonly PreparedExecutionAgentCapability[];
  capabilityCatalogGroupIds: readonly string[];
  activeCapabilityCatalogGroupIds: readonly string[] | null;
  inactiveCapabilityCatalogGroupIds: readonly string[];
  maxBatchCapabilityExecutions: number;
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  allowRespond: boolean;
  allowPlanner: boolean;
  allowAuditor: boolean;
  availableAuditCriterionIds: readonly string[];
  includeWorkingDirectory: boolean;
}>;

type CapabilityDecisionSchemaGroup = Readonly<{
  capabilities: readonly PreparedExecutionAgentCapability[];
  partition: CapabilityControlsPartition;
}>;

export function createExecutionAgentDecisionFormat(
  options: ExecutionAgentDecisionContractOptions = {},
): ModelGatewayJsonSchemaFormat {
  const contract = prepareExecutionAgentDecisionContract(options);
  const presentation = presentationSchemas(contract);
  const capabilityGroups = groupCapabilitiesByDecisionShape(
    contract.capabilities,
  );
  const observationGroups = groupCapabilitiesByDecisionShape(
    contract.observationCapabilities,
  );
  const batchEnabled =
    contract.maxBatchCapabilityExecutions >= 2 &&
    canOfferCapabilityBatchSelection(
      contract.observationCapabilities.map((capability) => ({
        capabilityId: capability.capabilityId,
        selectionSchema: capability.partition.selectionSchema,
      })),
    );
  const variants: Record<string, unknown>[] = [
    ...(contract.activeCapabilityCatalogGroupIds === null &&
    contract.capabilityCatalogGroupIds.length > 0
      ? [
          exactObject({
            action: literal("open_capability_scope"),
            catalogGroupIds: capabilityScopeGroupIdsSchema(
              contract.capabilityCatalogGroupIds,
            ),
            ...presentation,
          }),
        ]
      : []),
    ...(contract.allowRespond
      ? [
          exactObject({
            action: literal("respond"),
            ...presentation,
          }),
        ]
      : []),
    exactObject({
      action: literal("blocked"),
      response: boundedText(EXECUTION_AGENT_RESPONSE_MAX_LENGTH),
      ...presentation,
    }),
    ...capabilityGroups.map((group) =>
      exactObject({
        action: literal("invoke_capability"),
        capabilityId: enumeration(
          group.capabilities.map(({ capabilityId }) => capabilityId),
        ),
        intent: boundedText(CAPABILITY_INTENT_MAX_LENGTH),
        ...(requiresExecutionOperationObjective(group.partition)
          ? { operationObjective: executionOperationObjectiveSchema() }
          : {}),
        ...(group.partition.selectionControlIds.length > 0
          ? {
              selectionControls: projectControlsSchema(
                group.partition.selectionSchema,
              ),
            }
          : {}),
        ...presentation,
        ...(contract.includeWorkingDirectory
          ? { workingDirectory: nullable(workingDirectorySchema()) }
          : {}),
      }),
    ),
    ...(batchEnabled
      ? [
          exactObject({
            action: literal("invoke_capabilities"),
            invocations: {
              type: "array",
              minItems: 2,
              maxItems: contract.maxBatchCapabilityExecutions,
              items: projectCapabilitySelectionItemSchema(observationGroups),
            },
            ...presentation,
            ...(contract.includeWorkingDirectory
              ? { workingDirectory: nullable(workingDirectorySchema()) }
              : {}),
          }),
        ]
      : []),
    ...(contract.activeCapabilityCatalogGroupIds !== null &&
    contract.inactiveCapabilityCatalogGroupIds.length > 0
      ? [
          exactObject({
            action: literal("extend_capability_scope"),
            catalogGroupIds: capabilityScopeGroupIdsSchema(
              contract.inactiveCapabilityCatalogGroupIds,
            ),
            ...presentation,
          }),
        ]
      : []),
    ...(contract.allowPlanner
      ? [
          exactObject({
            action: literal("invoke_planner"),
            objective: boundedText(EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH),
            ...presentation,
          }),
        ]
      : []),
    ...(contract.allowAuditor && contract.availableAuditCriterionIds.length > 0
      ? [
          exactObject({
            action: literal("invoke_auditor"),
            criterionIds: boundedTextArray({
              itemMaxLength: EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH,
              maxItems: EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX,
              allowedValues: contract.availableAuditCriterionIds,
            }),
            ...presentation,
          }),
        ]
      : []),
  ];
  const schema = createStructuredDecisionEnvelopeSchema(variants);
  return {
    type: "json_schema",
    name: "execution_agent_decision",
    strict: true,
    postValidatedSchemaConstraints: collectMaxLengthConstraints(schema),
    schema,
  };
}

function workingDirectorySchema(): Record<string, unknown> {
  return {
    type: "string",
    minLength: 1,
    maxLength: EXECUTION_WORKING_DIRECTORY_MAX_LENGTH,
    pattern: EXECUTION_WORKING_DIRECTORY_PATTERN,
    description:
      "One portable relative directory path only (for example '.', 'AbotBlog', or 'project/site'); never a command, quoted shell expression, or absolute path.",
  };
}

export function prepareExecutionAgentDecisionContract(
  options: ExecutionAgentDecisionContractOptions,
): PreparedExecutionAgentDecisionContract {
  const suppliedCapabilityCatalogGroupIds =
    options.capabilityCatalogGroupIds ?? [];
  if (!Array.isArray(suppliedCapabilityCatalogGroupIds)) {
    throw new Error("execution_agent_capability_catalog_groups_invalid");
  }
  const capabilityCatalogGroupIds = Object.freeze([
    ...new Set(suppliedCapabilityCatalogGroupIds),
  ]);
  if (
    options.capabilityCatalogGroupIds !== undefined &&
    (capabilityCatalogGroupIds.length !==
      options.capabilityCatalogGroupIds.length ||
      capabilityCatalogGroupIds.length >
        EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX ||
      capabilityCatalogGroupIds.some(
        (groupId) => !isToolCatalogGroupId(groupId),
      ))
  ) {
    throw new Error("execution_agent_capability_catalog_groups_invalid");
  }
  const suppliedActiveCapabilityCatalogGroupIds =
    options.activeCapabilityCatalogGroupIds;
  if (
    suppliedActiveCapabilityCatalogGroupIds !== undefined &&
    suppliedActiveCapabilityCatalogGroupIds !== null &&
    !Array.isArray(suppliedActiveCapabilityCatalogGroupIds)
  ) {
    throw new Error("execution_agent_active_capability_scope_invalid");
  }
  const activeCapabilityCatalogGroupIds =
    suppliedActiveCapabilityCatalogGroupIds === undefined ||
    suppliedActiveCapabilityCatalogGroupIds === null
      ? null
      : Object.freeze([...new Set(suppliedActiveCapabilityCatalogGroupIds)]);
  if (
    activeCapabilityCatalogGroupIds !== null &&
    (activeCapabilityCatalogGroupIds.length === 0 ||
      activeCapabilityCatalogGroupIds.length >
        EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX ||
      activeCapabilityCatalogGroupIds.length !==
        suppliedActiveCapabilityCatalogGroupIds!.length ||
      activeCapabilityCatalogGroupIds.some(
        (groupId) => !isToolCatalogGroupId(groupId),
      ))
  ) {
    throw new Error("execution_agent_active_capability_scope_invalid");
  }
  const activeCapabilityCatalogGroupIdSet = new Set(
    activeCapabilityCatalogGroupIds ?? [],
  );
  const inactiveCapabilityCatalogGroupIds = Object.freeze(
    capabilityCatalogGroupIds.filter(
      (groupId) => !activeCapabilityCatalogGroupIdSet.has(groupId),
    ),
  );
  if (
    options.capabilities !== undefined &&
    !Array.isArray(options.capabilities)
  ) {
    throw new Error("execution_agent_capabilities_invalid");
  }
  const suppliedCapabilities = options.capabilities ?? [];
  const maxBatchCapabilityExecutions =
    options.maxBatchCapabilityExecutions ?? 0;
  const uniqueIds = new Set(
    suppliedCapabilities.map((capability) => capability?.capabilityId),
  );
  if (
    suppliedCapabilities.length > CAPABILITY_COUNT_MAX ||
    uniqueIds.size !== suppliedCapabilities.length ||
    !Number.isInteger(maxBatchCapabilityExecutions) ||
    maxBatchCapabilityExecutions < 0 ||
    maxBatchCapabilityExecutions > CAPABILITY_COUNT_MAX
  ) {
    throw new Error("execution_agent_capabilities_invalid");
  }
  const capabilities = Object.freeze(
    suppliedCapabilities.map((capability) => {
      const normalized = normalizeCapabilityDescriptor(capability);
      if (!normalized.ok) {
        throw new Error("execution_agent_capabilities_invalid");
      }
      const controls = normalizeCapabilityControlsSchema(
        normalized.value.controls,
      );
      if (!controls.ok) {
        throw new Error("execution_agent_capabilities_invalid");
      }
      const partition = partitionCapabilityControlsSchema(
        controls.value,
        normalized.value.selectionControlIds,
      );
      if (!partition.ok) {
        throw new Error("execution_agent_capabilities_invalid");
      }
      return Object.freeze({
        capabilityId: normalized.value.capabilityId,
        effect: normalized.value.effect,
        partition: partition.value,
      });
    }),
  );
  const availableAuditCriterionIds = Object.freeze([
    ...new Set(options.availableAuditCriterionIds ?? []),
  ]);
  if (
    options.availableAuditCriterionIds !== undefined &&
    (!Array.isArray(options.availableAuditCriterionIds) ||
      availableAuditCriterionIds.length !==
        options.availableAuditCriterionIds.length ||
      availableAuditCriterionIds.some(
        (criterionId) =>
          typeof criterionId !== "string" ||
          criterionId.length === 0 ||
          criterionId.length > EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH,
      ))
  ) {
    throw new Error("execution_agent_audit_criteria_invalid");
  }
  return Object.freeze({
    capabilities,
    observationCapabilities: Object.freeze(
      capabilities.filter(({ effect }) => effect === "observation"),
    ),
    capabilityCatalogGroupIds,
    activeCapabilityCatalogGroupIds,
    inactiveCapabilityCatalogGroupIds,
    maxBatchCapabilityExecutions,
    includeAcknowledgement: options.includeAcknowledgement === true,
    includeTitle: options.includeTitle === true,
    allowRespond: options.allowRespond !== false,
    allowPlanner: options.allowPlanner === true,
    allowAuditor: options.allowAuditor === true,
    availableAuditCriterionIds,
    includeWorkingDirectory: options.includeWorkingDirectory === true,
  });
}

function capabilityScopeGroupIdsSchema(
  offeredCatalogGroupIds: readonly string[],
): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: Math.min(
      EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX,
      offeredCatalogGroupIds.length,
    ),
    items: enumeration(offeredCatalogGroupIds),
  };
}

function presentationSchemas(
  contract: PreparedExecutionAgentDecisionContract,
): Record<string, unknown> {
  return {
    ...(contract.includeAcknowledgement
      ? {
          acknowledgement: boundedText(
            EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
            2,
          ),
        }
      : {}),
    ...(contract.includeTitle
      ? { title: boundedText(EXECUTION_AGENT_TITLE_MAX_LENGTH, 2) }
      : {}),
  };
}

function groupCapabilitiesByDecisionShape(
  capabilities: readonly PreparedExecutionAgentCapability[],
): readonly CapabilityDecisionSchemaGroup[] {
  const groups = new Map<
    string,
    {
      capabilities: PreparedExecutionAgentCapability[];
      partition: CapabilityControlsPartition;
    }
  >();
  for (const capability of capabilities) {
    const signature = JSON.stringify([
      capability.partition.selectionSchema,
      requiresExecutionOperationObjective(capability.partition),
    ]);
    const group = groups.get(signature) ?? {
      capabilities: [],
      partition: capability.partition,
    };
    group.capabilities.push(capability);
    groups.set(signature, group);
  }
  return Object.freeze(
    [...groups.values()].map((group) =>
      Object.freeze({
        capabilities: Object.freeze([...group.capabilities]),
        partition: group.partition,
      }),
    ),
  );
}

function projectCapabilitySelectionItemSchema(
  groups: readonly CapabilityDecisionSchemaGroup[],
): Record<string, unknown> {
  const variants = groups.map((group) =>
    exactObject({
      capabilityId: enumeration(
        group.capabilities.map(({ capabilityId }) => capabilityId),
      ),
      intent: boundedText(CAPABILITY_INTENT_MAX_LENGTH),
      ...(requiresExecutionOperationObjective(group.partition)
        ? { operationObjective: executionOperationObjectiveSchema() }
        : {}),
      ...(group.partition.selectionControlIds.length > 0
        ? {
            selectionControls: projectControlsSchema(
              group.partition.selectionSchema,
            ),
          }
        : {}),
    }),
  );
  return variants.length === 1 ? variants[0]! : { anyOf: variants };
}

function projectControlsSchema(
  schema: CapabilityControlsSchema,
): Record<string, unknown> {
  const required = new Set(schema.required);
  return exactObject(
    Object.fromEntries(
      Object.entries(schema.properties).map(([controlId, control]) => [
        controlId,
        required.has(controlId)
          ? projectControlSchema(control)
          : { anyOf: [projectControlSchema(control), { type: "null" }] },
      ]),
    ),
  );
}

function projectControlSchema(
  control: CapabilityControl,
): Record<string, unknown> {
  if (control.type === "array") {
    return {
      type: "array",
      items: projectControlSchema(control.items),
      minItems: control.minItems,
      maxItems: control.maxItems,
    };
  }
  if (control.type === "string" && "enum" in control) {
    return { type: "string", enum: [...control.enum] };
  }
  return { ...control };
}

function exactObject(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function literal(value: string): Record<string, unknown> {
  return enumeration([value]);
}

function nullable(schema: Record<string, unknown>): Record<string, unknown> {
  return { anyOf: [schema, { type: "null" }] };
}

function enumeration(values: readonly string[]): Record<string, unknown> {
  return { type: "string", enum: [...values] };
}

function boundedText(
  maxLength: number,
  minLength = 1,
): Record<string, unknown> {
  return { type: "string", minLength, maxLength };
}

function boundedTextArray(
  params: Readonly<{
    itemMaxLength: number;
    maxItems: number;
    allowedValues?: readonly string[];
  }>,
): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: params.maxItems,
    items: params.allowedValues
      ? enumeration(params.allowedValues)
      : boundedText(params.itemMaxLength),
  };
}

function collectMaxLengthConstraints(
  value: unknown,
  path = "",
): Array<Readonly<{ keyword: "maxLength"; path: string }>> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectMaxLengthConstraints(entry, `${path}/${index}`),
    );
  }
  if (!isRecord(value)) return [];
  return [
    ...(Object.hasOwn(value, "maxLength")
      ? [
          {
            keyword: "maxLength" as const,
            path: `${path}/maxLength`,
          },
        ]
      : []),
    ...Object.entries(value).flatMap(([key, child]) =>
      collectMaxLengthConstraints(child, `${path}/${escapeJsonPointer(key)}`),
    ),
  ];
}

function escapeJsonPointer(input: string): string {
  return input.replace(/~/gu, "~0").replace(/\//gu, "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
