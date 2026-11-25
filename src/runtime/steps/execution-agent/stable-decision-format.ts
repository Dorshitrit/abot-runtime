import type { ModelGatewayJsonSchemaFormat } from "../../../model-gateway/types.js";
import { createStructuredDecisionEnvelopeSchema } from "../../model/structured-decision-envelope.js";
import { canOfferCapabilityBatchSelection, type CapabilityDescriptor } from "../../orchestration/capability-adapters/index.js";
import { createMemoryRecallDecisionSchema } from "../memory-recall-decision.js";
import { addExecutionInteractionSchemas } from "./interaction-decision.js";
import { prepareExecutionAgentDecisionContract } from "./format.js";
import { directResponseVariants, EXECUTION_AGENT_DIRECT_RESPONSE_MAX_LENGTH } from "./direct-response-contract.js";
import { collectDecisionMaxLengthConstraints } from "../../model/decision-schema.js";
import {
  EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH, EXECUTION_AGENT_TITLE_MAX_LENGTH,
  EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX, EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH,
  EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX, EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX,
  EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH, EXECUTION_AGENT_RESPONSE_MAX_LENGTH,
  type ExecutionAgentDecisionContractOptions,
} from "./contracts.js";
import {
  canonicalizeDecisionSchema, nullableDecisionField, stableCapabilitySelectionGroups,
  stableDecisionDefinitions, stableDecisionObject, stableDecisionPresentation,
  stableDecisionText, stableDecisionWorkingDirectory, type ExecutionDecisionSchema,
} from "./stable-decision-schema.js";

/** Structural offers follow the live contract; numeric limits and evidence remain runtime-validated. */
export type StableExecutionAgentDecisionFormatOptions = Readonly<{
  capabilities: readonly CapabilityDescriptor[];
  capabilityCatalogGroupIds: readonly string[];
  activeCapabilityCatalogGroupIds: readonly string[] | null;
  includeAcknowledgement: boolean;
  includeTitle: boolean;
  includeWorkingDirectory: boolean;
  allowWorkPlan: boolean;
  allowUserInteraction: boolean;
  allowMemoryRecall: boolean;
  allowPlanner: boolean;
  allowAuditor: boolean;
  allowDirectResponse: boolean;
  allowMemoryAuthoring: boolean;
}>;

/** Use one live contract for the provider's semantic fields and the runtime parser. */
export function projectStableExecutionDecisionFormat(
  contract: ExecutionAgentDecisionContractOptions,
  scopedCapabilities: readonly CapabilityDescriptor[],
): ModelGatewayJsonSchemaFormat {
  return createStableExecutionAgentDecisionFormat({
    capabilities: scopedCapabilities,
    capabilityCatalogGroupIds: contract.capabilityCatalogGroupIds ?? [],
    activeCapabilityCatalogGroupIds: contract.activeCapabilityCatalogGroupIds ?? null,
    includeAcknowledgement: contract.includeAcknowledgement === true,
    includeTitle: contract.includeTitle === true,
    includeWorkingDirectory: contract.includeWorkingDirectory === true,
    allowWorkPlan: contract.workPlan !== undefined,
    allowUserInteraction: contract.allowUserInteraction === true,
    allowMemoryRecall: contract.allowMemoryRecall === true,
    allowPlanner: contract.allowPlanner === true,
    allowAuditor: contract.allowAuditor === true && (contract.availableAuditCriterionIds?.length ?? 0) > 0,
    allowDirectResponse: contract.directResponseMaxLength !== undefined,
    allowMemoryAuthoring: contract.directResponseMemoryAuthoring !== undefined,
  });
}

/** Provider transport only. The live decision contract remains the acceptance authority. */
export function createStableExecutionAgentDecisionFormat(
  options: StableExecutionAgentDecisionFormatOptions,
): ModelGatewayJsonSchemaFormat {
  const descriptors = options.capabilities.map((capability) => canonicalizeDecisionSchema(capability) as CapabilityDescriptor)
    .sort((left, right) => left.capabilityId < right.capabilityId ? -1 : Number(left.capabilityId > right.capabilityId));
  const groupIds = [...options.capabilityCatalogGroupIds].sort();
  const prepared = prepareExecutionAgentDecisionContract({ capabilities: descriptors, capabilityCatalogGroupIds: groupIds });
  const definitions = stableDecisionDefinitions();
  const capabilityGroups = stableCapabilitySelectionGroups(prepared.capabilities, definitions);
  const observationIds = new Set(prepared.observationCapabilities.map(({ capabilityId }) => capabilityId));
  const observationGroups = capabilityGroups.flatMap((group) => {
    const ids = (group.capabilityId as { enum: string[] }).enum.filter((id) => observationIds.has(id));
    return ids.length === 0 ? [] : [{ ...group, capabilityId: { type: "string", enum: ids } }];
  });
  const presentation = stableDecisionPresentation(options);
  const workingDirectory = options.includeWorkingDirectory
    ? { workingDirectory: stableDecisionWorkingDirectory() } : {};
  const variants: ExecutionDecisionSchema[] = [];
  const add = (action: string, properties: ExecutionDecisionSchema = {}) => {
    variants.push(stableDecisionObject({ action: { type: "string", enum: [action] }, ...properties, ...presentation }));
  };
  if (options.allowMemoryRecall) {
    const recall = createMemoryRecallDecisionSchema({
      acknowledgementMaxLength: EXECUTION_AGENT_ACKNOWLEDGEMENT_MAX_LENGTH,
      titleMaxLength: EXECUTION_AGENT_TITLE_MAX_LENGTH,
    });
    variants.push(stableDecisionObject({ ...(recall.properties as ExecutionDecisionSchema), ...presentation }));
  }
  const scopeTransition = projectStableCapabilityScopeTransition(groupIds, options.activeCapabilityCatalogGroupIds);
  if (scopeTransition) {
    const catalogGroupIds = {
      type: "array", minItems: 1, maxItems: EXECUTION_AGENT_CAPABILITY_SCOPE_GROUP_COUNT_MAX,
      items: { type: "string", enum: scopeTransition.catalogGroupIds },
    };
    add(scopeTransition.action, { catalogGroupIds });
  }
  add("respond");
  if (options.allowDirectResponse) {
    variants.push(...directResponseVariants(
      EXECUTION_AGENT_DIRECT_RESPONSE_MAX_LENGTH, presentation, options.allowMemoryAuthoring,
    ));
  }
  add("blocked", { response: stableDecisionText(EXECUTION_AGENT_RESPONSE_MAX_LENGTH) });
  for (const group of capabilityGroups)
    add("invoke_capability", { ...group, ...workingDirectory });
  if (canOfferCapabilityBatchSelection(prepared.observationCapabilities.map(({ capabilityId, partition }) => ({
    capabilityId, selectionSchema: partition.selectionSchema,
  })))) {
    add("invoke_capabilities", {
      invocations: {
        type: "array", minItems: 2, maxItems: EXECUTION_AGENT_CAPABILITY_BATCH_COUNT_MAX,
        items: observationGroups.length === 1 ? stableDecisionObject(observationGroups[0]!)
          : { anyOf: observationGroups.map(stableDecisionObject) },
      },
      ...workingDirectory,
    });
  }
  if (options.allowPlanner) add("invoke_planner", { objective: stableDecisionText(EXECUTION_AGENT_OBJECTIVE_MAX_LENGTH) });
  if (options.allowAuditor) add("invoke_auditor", {
    criterionIds: { type: "array", minItems: 1, maxItems: EXECUTION_AGENT_AUDIT_CRITERION_COUNT_MAX,
      items: stableDecisionText(EXECUTION_AGENT_AUDIT_CRITERION_ID_MAX_LENGTH) },
  });
  const interactive = addExecutionInteractionSchemas(variants, options.allowUserInteraction);
  const projected = options.allowWorkPlan ? interactive.map((variant) => stableDecisionObject({
    ...(variant.properties as ExecutionDecisionSchema),
    workPlan: nullableDecisionField({ $ref: "#/$defs/workPlan" }),
  })) : interactive;
  if (!options.allowWorkPlan) delete definitions.workPlan;
  if (!options.includeWorkingDirectory) delete definitions.workingDirectory;
  const schema = canonicalizeDecisionSchema({
    ...createStructuredDecisionEnvelopeSchema(projected),
    ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
  }) as ExecutionDecisionSchema;
  return { type: "json_schema", name: "execution_agent_decision", strict: true,
    postValidatedSchemaConstraints: collectDecisionMaxLengthConstraints(schema), schema };
}

/** Only canonical scope transitions change this structural offer, never remaining limits. */
function projectStableCapabilityScopeTransition(
  knownGroupIds: readonly string[],
  activeGroupIds: readonly string[] | null,
) {
  if (knownGroupIds.length === 0) return undefined;
  if (activeGroupIds === null)
    return { action: "open_capability_scope", catalogGroupIds: knownGroupIds };
  const inactiveGroupIds = knownGroupIds.filter((groupId) => !activeGroupIds.includes(groupId));
  if (inactiveGroupIds.length === 0) return undefined;
  return { action: "extend_capability_scope", catalogGroupIds: inactiveGroupIds };
}
