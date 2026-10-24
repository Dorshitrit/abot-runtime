import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { directResponseVariants } from "./direct-response-contract.js";
import { createMemoryRecallDecisionSchema } from "../memory-recall-decision.js";
import { createExecutionWorkPlanDecisionSchema } from "./work-plan-schema.js";
import { isToolCatalogGroupId } from "../../../capabilities/tool-types.js";
import {
  CAPABILITY_COUNT_MAX,
  EXECUTION_WORKING_DIRECTORY_MAX_LENGTH,
  EXECUTION_WORKING_DIRECTORY_PATTERN,
  canOfferCapabilityBatchSelection,
  normalizeCapabilityDescriptor,
  type CapabilityControlsPartition,
  type CapabilityDescriptor,
} from "../../orchestration/capability-adapters/index.js";
import {
  EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
  EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX,
  EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH,
  EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX,
  EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX,
  EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH,
  EXECUTION_AGENT_RESPONSE_MAX_LENGTH,
  EXECUTION_AGENT_TITLE_MAX_LENGTH,
  type ExecutionAgentDecisionContractOptions,
} from "./contracts.js";
import { partitionExecutionCapabilityControls } from "./capability-controls-partition.js";
import { projectCapabilitySelectionProperties } from "./capability-selection-schema.js";
import { freezeControlsEvidenceEligibility } from "./controls-evidence-contract.js";

export type PreparedExecutionAgentCapability = Readonly<{
  capabilityId: string;
  effect: CapabilityDescriptor["effect"];
  partition: CapabilityControlsPartition;
  requiresPayloadAuthoringObjective: boolean;
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
  allowMemoryRecall: boolean;
  allowPlanner: boolean;
  allowAuditor: boolean;
  availableAuditCriterionIds: readonly string[];
  includeWorkingDirectory: boolean;
  eligibleControlsEvidenceExecutionIds: readonly string[];
}>;

export function createExecutionAgentDecisionFormat(
  options: ExecutionAgentDecisionContractOptions = {},
): ModelGatewayJsonSchemaFormat {
  const contract = prepareExecutionAgentDecisionContract(options);
  const presentation = presentationSchemas(contract);
  const capabilityGroups = projectCapabilitySelectionProperties(
    contract.capabilities,
    contract.eligibleControlsEvidenceExecutionIds,
  );
  const observationGroups = projectCapabilitySelectionProperties(
    contract.observationCapabilities,
    contract.eligibleControlsEvidenceExecutionIds,
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
    ...(contract.allowMemoryRecall
      ? [
          createMemoryRecallDecisionSchema({
            includeAcknowledgement: contract.includeAcknowledgement,
            includeTitle: contract.includeTitle,
            acknowledgementMaxLength:
              EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
            titleMaxLength: EXECUTION_AGENT_TITLE_MAX_LENGTH,
          }),
        ]
      : []),
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
          ...directResponseVariants(
            options.directResponseMaxLength, presentation,
            options.directResponseMemoryAuthoring !== undefined,
          ),
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
        ...group,
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
  const schema = createExecutionWorkPlanDecisionSchema(
    variants,
    options.workPlan,
  );
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
    maxBatchCapabilityExecutions > EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX
  ) {
    throw new Error("execution_agent_capabilities_invalid");
  }
  const capabilities = Object.freeze(
    suppliedCapabilities.map((capability) => {
      const normalized = normalizeCapabilityDescriptor(capability);
      if (!normalized.ok) {
        throw new Error("execution_agent_capabilities_invalid");
      }
      const partition = partitionExecutionCapabilityControls(normalized.value);
      if (!partition.ok) {
        throw new Error("execution_agent_capabilities_invalid");
      }
      return Object.freeze({
        capabilityId: normalized.value.capabilityId,
        effect: normalized.value.effect,
        partition: partition.value,
        requiresPayloadAuthoringObjective:
          normalized.value.requiresPayloadAuthoringObjective === true,
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
    allowMemoryRecall: options.allowMemoryRecall === true,
    allowPlanner: options.allowPlanner === true,
    allowAuditor: options.allowAuditor === true,
    availableAuditCriterionIds,
    includeWorkingDirectory: options.includeWorkingDirectory === true,
    eligibleControlsEvidenceExecutionIds: freezeControlsEvidenceEligibility(
      options.eligibleControlsEvidenceExecutionIds,
    ),
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

function projectCapabilitySelectionItemSchema(
  groups: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown> {
  const variants = groups.map(exactObject);
  return variants.length === 1 ? variants[0]! : { anyOf: variants };
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
