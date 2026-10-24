import { TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH } from "../../../capabilities/normal-invocation/contracts.js";
import type { AutomationCatalogOperation } from "../../automations/catalog.js";
import type { AutomationService } from "../../automations/service.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../automation-builder/authoring-reference.js";

// Percent-encoding expands one UTF-16 unit by at most nine characters.
// Both canonical identifiers are bounded; preserve every safe integer version too.
export const AUTOMATION_CATALOG_OPERATION_REF_MAX_LENGTH =
  2 * TOOL_NORMAL_INVOCATION_IDENTIFIER_MAX_LENGTH * 9 + 2 + String(Number.MAX_SAFE_INTEGER).length;

const PAGE_SIZE = 50;
const LABEL_MAX_LENGTH = 160;
type CatalogService = Pick<AutomationService, "catalog">;
type AuthoringCatalog = Awaited<ReturnType<AutomationService["catalog"]>>;

function isCatalogIndexOffset(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (value < 0) return false;
  return value <= 2_147_483_647;
}

function catalogPage<T>(items: readonly T[], offset: number) {
  const page = items.slice(offset, offset + PAGE_SIZE);
  const omittedCount = Math.max(0, items.length - offset - page.length);
  return { items: page, offset, totalCount: items.length, omittedCount,
    nextOffset: omittedCount > 0 ? offset + page.length : null };
}

function operationKey(operation: AutomationCatalogOperation): string {
  return JSON.stringify([operation.toolName, operation.operationId, operation.contractVersion]);
}

/** Opaque identity copied from discovery; consumers never synthesize or parse it. */
export function automationCatalogOperationRef(
  operation: Pick<AutomationCatalogOperation, "toolName" | "operationId" | "contractVersion">,
): string {
  return `${encodeURIComponent(operation.toolName)}/${encodeURIComponent(operation.operationId)}@${operation.contractVersion}`;
}

function isCatalogReferenceName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > 64) return false;
  return value.trim() === value && value.trim().length > 0;
}

function isCatalogAutomationId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.trim().length === 0) return false;
  return value.length <= 128;
}

export function requireAutomationCatalogScope(params: Readonly<Record<string, unknown>>): string {
  if (params.automationId === undefined) return "";
  if (!isCatalogAutomationId(params.automationId))
    throw new Error("automation_catalog_parameters_invalid");
  return params.automationId;
}

/** Requested grant scope only; catalog reads do not establish draft existence. */
export function automationAuthoringCatalogScope(automationId: string) {
  return automationId
    ? { kind: "automation" as const, automationId }
    : { kind: "pre_draft" as const };
}

function isCatalogContractVersion(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  if (value < 1) return false;
  return value <= 2_147_483_647;
}

function requireCatalogOperationReference(params: Readonly<Record<string, unknown>>) {
  const { toolName, operationId, contractVersion } = params;
  if (!isCatalogReferenceName(toolName)) throw new Error("automation_catalog_operation_reference_invalid");
  if (!isCatalogReferenceName(operationId)) throw new Error("automation_catalog_operation_reference_invalid");
  if (!isCatalogContractVersion(contractVersion)) throw new Error("automation_catalog_operation_reference_invalid");
  return { toolName, operationId, contractVersion };
}

function hasCatalogOperationReferenceFields(params: Readonly<Record<string, unknown>>): boolean {
  return ["toolName", "operationId", "contractVersion"].some((key) => params[key] !== undefined);
}

/** Validate the view-specific flat API before reading the canonical catalog. */
export async function readAutomationAuthoringCatalog(
  service: CatalogService,
  params: Readonly<Record<string, unknown>>,
) {
  const automationId = requireAutomationCatalogScope(params);
  const isIndexView = params.view === "index";
  const hasUnexpectedIndexReference = isIndexView && hasCatalogOperationReferenceFields(params);
  if (hasUnexpectedIndexReference) throw new Error("automation_catalog_parameters_invalid");
  if (isIndexView) {
    return readAutomationAuthoringCatalogIndex(service, automationId,
      params.offset === undefined ? 0 : params.offset);
  }
  const isOperationView = params.view === "operation";
  if (!isOperationView) throw new Error("automation_catalog_view_invalid");
  const hasUnexpectedOperationOffset = params.offset !== undefined;
  if (hasUnexpectedOperationOffset) throw new Error("automation_catalog_parameters_invalid");
  const reference = requireCatalogOperationReference(params);
  return readAutomationAuthoringCatalogOperation(service, automationId,
    reference.toolName, reference.operationId, reference.contractVersion);
}

/** A paged discovery view derived only from the configured automation catalog. */
export async function readAutomationAuthoringCatalogIndex(
  service: CatalogService,
  automationId: string,
  offset: unknown,
) {
  if (!isCatalogIndexOffset(offset)) throw new Error("automation_offset_invalid");
  const catalog = await service.catalog(automationId);
  return projectAutomationAuthoringCatalogIndex(catalog, offset, automationId);
}

/** Shared bounded projection; preparation reuses its already-read catalog snapshot. */
export function projectAutomationAuthoringCatalogIndex(
  catalog: AuthoringCatalog, offset: number, automationId: string,
) {
  const granted = new Set(catalog.operations.map(operationKey));
  const operations = catalogPage([...catalog.grantableOperations]
    .sort((left, right) => operationKey(left).localeCompare(operationKey(right)))
    .map((operation) => ({
      ref: automationCatalogOperationRef(operation),
      toolName: operation.toolName, operationId: operation.operationId,
      contractVersion: operation.contractVersion,
      label: operation.label.slice(0, LABEL_MAX_LENGTH),
      labelTruncated: operation.label.length > LABEL_MAX_LENGTH,
      ...(operation.pluginName ? { pluginName: operation.pluginName } : {}),
      catalogGroups: operation.catalogGroups, permissionMode: operation.permissionMode,
      effect: operation.effect, granted: granted.has(operationKey(operation)),
    })), offset);
  const models = catalogPage([...catalog.models]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((model) => ({
      id: model.id, label: model.label.slice(0, LABEL_MAX_LENGTH),
      labelTruncated: model.label.length > LABEL_MAX_LENGTH,
      ...(model.provider ? { provider: model.provider } : {}),
      ...(model.reasoningControls ? { reasoningControls: model.reasoningControls } : {}),
    })), offset);
  const savedAgents = catalogPage([...catalog.savedAgents]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((agent) => ({
      agentId: agent.id, revision: agent.revision,
      title: agent.title.slice(0, LABEL_MAX_LENGTH),
      titleTruncated: agent.title.length > LABEL_MAX_LENGTH,
      modelProfileId: agent.modelProfileId,
    })), offset);
  const totalCount = Math.max(operations.totalCount, models.totalCount, savedAgents.totalCount);
  return {
    kind: "automation_authoring_catalog_index_v1" as const, grantsPermissions: false as const,
    catalogScope: automationAuthoringCatalogScope(automationId),
    permissions: AUTOMATION_AUTHORING_REFERENCE.permissions,
    offset, pageSize: PAGE_SIZE,
    // Every collection advances by the same page size; none can lose an intermediate page.
    nextOffset: offset + PAGE_SIZE < totalCount ? offset + PAGE_SIZE : null,
    operations, models, savedAgents,
  };
}

/** Resolve an exact, current operation reference without granting or selecting it. */
export async function readAutomationAuthoringCatalogOperation(
  service: CatalogService,
  automationId: string,
  toolName: string,
  operationId: string,
  contractVersion: number,
) {
  const catalog = await service.catalog(automationId);
  const matchesReference = (operation: AutomationCatalogOperation) =>
    operation.toolName === toolName && operation.operationId === operationId &&
    operation.contractVersion === contractVersion;
  const selected = catalog.grantableOperations.find(matchesReference);
  if (!selected) throw new Error("automation_catalog_operation_not_found");
  const { fixedParams: _fixedParams, outputChannels: _outputChannels, ...operation } = selected;
  return {
    kind: "automation_authoring_catalog_operation_v1" as const,
    catalogScope: automationAuthoringCatalogScope(automationId),
    permissions: AUTOMATION_AUTHORING_REFERENCE.permissions,
    grantsPermissions: false as const, operation,
    granted: catalog.operations.some(matchesReference),
  };
}
