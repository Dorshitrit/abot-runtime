import { expect, test, vi } from "vitest";
import type { AutomationService } from "../automations/service.js";
import type { AutomationCatalogOperation } from "../automations/catalog.js";
import { automationCatalogOperationRef, readAutomationAuthoringCatalogIndex,
  readAutomationAuthoringCatalogOperation } from "../capabilities/automations/authoring-catalog.js";
import { readAutomationAuthoringPreparation } from "../capabilities/automations/authoring-preparation.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";

test("authoring discovery, exact detail, preparation and legacy catalog retain request binding without granting access", async () => {
  const bound: AutomationCatalogOperation = { toolName: "custom_bound_tool", operationId: "read", contractVersion: 1,
    label: "Read", catalogGroups: [], permissionMode: "full_access", effect: "read_only", approval: "request_policy",
    input: { type: "object", additionalProperties: false, properties: {}, required: [] }, requiresRequestBinding: true };
  const { requiresRequestBinding: _binding, ...direct } = { ...bound, toolName: "direct_tool" };
  const source: Awaited<ReturnType<AutomationService["catalog"]>> = {
    operations: [], grantableOperations: [bound, direct], models: [], savedAgents: [], templates: [],
  };
  const service = { catalog: vi.fn(async () => source) };
  const page = await readAutomationAuthoringCatalogIndex(service, "", 0);
  expect(page.operations.items.find((item) => item.toolName === bound.toolName))
    .toMatchObject({ requiresRequestBinding: true, granted: false });
  expect(page.operations.items.find((item) => item.toolName === direct.toolName)).not.toHaveProperty("requiresRequestBinding");

  const detail = await readAutomationAuthoringCatalogOperation(service, "", bound.toolName, bound.operationId, bound.contractVersion);
  expect(detail).toMatchObject({ grantsPermissions: false, granted: false, operation: { requiresRequestBinding: true } });
  const prepared = await readAutomationAuthoringPreparation(service, { operationRefs: [automationCatalogOperationRef(bound)] });
  expect(prepared).toMatchObject({ grantsPermissions: false, executesWorkflow: false,
    operations: [{ requiresRequestBinding: true, granted: false }] });

  const module = createAutomationDraftToolModule(() => service as unknown as AutomationService, async () => undefined);
  const legacy = await module.implementation({ action: "catalog", automationId: "draft" });
  expect(legacy.ok).toBe(true);
  expect(JSON.parse(legacy.output)).toMatchObject({ grantsPermissions: false, grantedOperations: [],
    operations: [expect.objectContaining({ requiresRequestBinding: true }), expect.not.objectContaining({ requiresRequestBinding: true })] });
  expect(source.operations).toEqual([]);
});
