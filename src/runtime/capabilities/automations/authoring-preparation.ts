import type { AutomationService } from "../../automations/service.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../automation-builder/authoring-reference.js";
import { AUTOMATION_AUTHORING_PREPARATION_LIMITS } from "./authoring-preparation-limits.js";
import {
  AUTOMATION_CATALOG_OPERATION_REF_MAX_LENGTH,
  automationAuthoringCatalogScope,
  automationCatalogOperationRef,
  projectAutomationAuthoringCatalogIndex,
  requireAutomationCatalogScope,
} from "./authoring-catalog.js";

type CatalogService = Pick<AutomationService, "catalog">;

function isBoundedOperationRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > AUTOMATION_CATALOG_OPERATION_REF_MAX_LENGTH) return false;
  return value.trim() === value;
}

function requirePreparationOperationRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("automation_preparation_operation_refs_invalid");
  if (value.length > AUTOMATION_AUTHORING_PREPARATION_LIMITS.operationRefs)
    throw new Error("automation_preparation_operation_refs_invalid");
  if (!value.every(isBoundedOperationRef))
    throw new Error("automation_preparation_operation_refs_invalid");
  if (new Set(value).size !== value.length)
    throw new Error("automation_preparation_duplicate_operation_ref");
  return value;
}

/** Read one canonical snapshot and resolve only explicitly selected operation identities. */
export async function readAutomationAuthoringPreparation(
  service: CatalogService,
  params: Readonly<Record<string, unknown>>,
) {
  const automationId = requireAutomationCatalogScope(params);
  const operationRefs = requirePreparationOperationRefs(params.operationRefs);
  const catalog = await service.catalog(automationId);
  const available = new Map(catalog.grantableOperations.map((operation) =>
    [automationCatalogOperationRef(operation), operation] as const));
  const granted = new Set(catalog.operations.map(automationCatalogOperationRef));
  const operations = operationRefs.map((ref) => {
    const selected = available.get(ref);
    if (!selected) throw new Error("automation_catalog_operation_not_found");
    const { fixedParams: _fixedParams, ...operation } = selected;
    return { ref, ...operation, granted: granted.has(ref) };
  });
  const { models, savedAgents } = projectAutomationAuthoringCatalogIndex(catalog, 0, automationId);
  const result = {
    kind: "automation_authoring_preparation_v1" as const,
    authority: "runtime_registry" as const,
    catalogScope: automationAuthoringCatalogScope(automationId),
    presenceEffect: "authoring_reference_not_user_intent_or_execution" as const,
    grantsPermissions: false as const,
    executesWorkflow: false as const,
    maxBytes: AUTOMATION_AUTHORING_PREPARATION_LIMITS.outputBytes,
    operations, models, savedAgents,
    authoringReference: AUTOMATION_AUTHORING_REFERENCE,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > AUTOMATION_AUTHORING_PREPARATION_LIMITS.outputBytes)
    throw new Error("automation_preparation_output_too_large");
  return result;
}
