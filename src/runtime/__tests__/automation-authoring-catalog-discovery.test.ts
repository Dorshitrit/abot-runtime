import { describe, expect, it, vi } from "vitest";
import { parseToolNormalInvocationContract } from "../../capabilities/normal-invocation/validator.js";
import type { AutomationCatalogOperation } from "../automations/catalog.js";
import type { AutomationService } from "../automations/service.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../capabilities/automation-builder/authoring-reference.js";
import {
  automationCatalogOperationRef,
  readAutomationAuthoringCatalog,
  readAutomationAuthoringCatalogIndex,
  readAutomationAuthoringCatalogOperation,
} from "../capabilities/automations/authoring-catalog.js";
import { automationDraftToolContract } from "../capabilities/automations/tool-contract.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";

type Catalog = Awaited<ReturnType<AutomationService["catalog"]>>;
const id = (prefix: string, index: number) => `${prefix}_${String(index).padStart(3, "0")}`;

function operation(index: number): AutomationCatalogOperation {
  return {
    toolName: id("reader", index), operationId: "read", contractVersion: 2,
    label: `Read source ${index}`, pluginName: "configured-reader", catalogGroups: ["files"],
    toolDescription: "Complete tool description is only needed for detailed configuration.",
    permissionMode: "full_plus", effect: "mutating", approval: "request_policy",
    input: { type: "object", additionalProperties: false,
      properties: { path: { type: "string", minLength: 1, maxLength: 1_024 } }, required: ["path"] },
    fixedParams: { action: "private_action" }, selectionControlIds: ["path"],
    payload: { kind: "raw_text", param: "content", instructions: "Use the supplied content.", maxBytes: 4_096 },
  };
}

function fixture(operationCount = 54, modelCount = 2, agentCount = 1) {
  const grantableOperations = Array.from({ length: operationCount }, (_, index) => operation(index));
  const source: Catalog = {
    operations: grantableOperations.slice(0, 1), grantableOperations, templates: [],
    models: Array.from({ length: modelCount }, (_, index) => ({
      id: id("model", index), label: `Model ${index}`, provider: "configured-provider",
    })),
    savedAgents: Array.from({ length: agentCount }, (_, index) => ({
      id: id("saved", index), revision: 3, title: `Saved agent ${index}`, modelProfileId: "model_000",
      agent: { kind: "agent", id: id("agent", index), title: `Saved agent ${index}`, onFailure: "stop",
        modelProfileId: "model_000", agentMode: "fast", roleInstructions: "Private saved role",
        prompt: "Private saved prompt", inputs: {}, tools: [], result: { kind: "text" } },
    })),
  };
  const catalog = vi.fn(async () => source);
  const service = { catalog };
  const module = createAutomationDraftToolModule(() => service as unknown as AutomationService, async () => undefined);
  const registry = createConfiguredToolRegistry(undefined, [module]);
  return { source, service, catalog, registry, module };
}

describe("automation authoring catalog discovery", () => {
  it("explains pre-draft future grants without denying current chat authoring", async () => {
    const f = fixture(2);
    f.source.operations = [];
    const page = await readAutomationAuthoringCatalogIndex(f.service, "", 0);
    expect(page).toMatchObject({ catalogScope: { kind: "pre_draft" },
      permissions: { kind: "automation_authoring_permissions_v1", authority: "capability_contract",
        granted: expect.stringContaining("future workflow"),
        grantsPermissions: expect.stringContaining("read"),
        currentChat: expect.stringContaining("does not determine") } });
    expect(page.operations.items.every(({ granted }) => granted === false)).toBe(true);
    expect(page).not.toHaveProperty("authoringAllowed");
    expect(f.catalog).toHaveBeenCalledExactlyOnceWith("");
  });

  it("preserves the valid bounded legacy invocation contract", () => {
    const contract = parseToolNormalInvocationContract("automations", automationDraftToolContract);
    expect(contract?.operations).toHaveLength(32);
    expect(contract?.operations.some(({ operationId }) => operationId === "prepare_draft")).toBe(false);
  });

  it("returns compact exact references and marks existing grants without authorizing anything", async () => {
    const f = fixture();
    const page = await readAutomationAuthoringCatalogIndex(f.service, "draft-id", 0);
    expect(f.catalog).toHaveBeenCalledExactlyOnceWith("draft-id");
    expect(page).toMatchObject({ kind: "automation_authoring_catalog_index_v1",
      catalogScope: { kind: "automation", automationId: "draft-id" },
      grantsPermissions: false, offset: 0, pageSize: 50, nextOffset: 50 });
    expect(page.permissions).toBe(AUTOMATION_AUTHORING_REFERENCE.permissions);
    expect(page.operations).toMatchObject({ offset: 0, totalCount: 54, omittedCount: 4, nextOffset: 50 });
    expect(page.operations.items).toHaveLength(50);
    expect(page.operations.items[0]).toMatchObject({ toolName: "reader_000", operationId: "read",
      ref: "reader_000/read@2", contractVersion: 2, permissionMode: "full_plus", granted: true });
    expect(page.operations.items[1]?.granted).toBe(false);
    for (const entry of page.operations.items) {
      expect(entry).not.toHaveProperty("input");
      expect(entry).not.toHaveProperty("payload");
      expect(entry).not.toHaveProperty("fixedParams");
      expect(entry).not.toHaveProperty("toolDescription");
    }
    expect(page.models.items[0]?.id).toBe("model_000");
    expect(page.savedAgents.items[0]).not.toHaveProperty("agent");
    expect(JSON.stringify(page)).not.toContain("Private saved prompt");
  });

  it("pages all collections independently without dropping models or saved agents", async () => {
    const f = fixture(54, 105, 76);
    f.source.grantableOperations.reverse();
    f.source.models.reverse();
    f.source.savedAgents.reverse();
    const first = await readAutomationAuthoringCatalogIndex(f.service, "draft-id", 0);
    const second = await readAutomationAuthoringCatalogIndex(f.service, "draft-id", first.nextOffset);
    const third = await readAutomationAuthoringCatalogIndex(f.service, "draft-id", second.nextOffset);
    expect([first.nextOffset, second.nextOffset, third.nextOffset]).toEqual([50, 100, null]);
    expect(second.operations).toMatchObject({ totalCount: 54, omittedCount: 0, nextOffset: null });
    expect(second.models).toMatchObject({ totalCount: 105, omittedCount: 5, nextOffset: 100 });
    expect(second.savedAgents).toMatchObject({ totalCount: 76, omittedCount: 0, nextOffset: null });
    const pages = [first, second, third];
    for (const page of pages) {
      expect(page.catalogScope).toEqual({ kind: "automation", automationId: "draft-id" });
      expect(page.permissions).toBe(AUTOMATION_AUTHORING_REFERENCE.permissions);
    }
    expect(pages.flatMap((page) => page.operations.items.map((item) => item.toolName)))
      .toEqual(Array.from({ length: 54 }, (_, index) => id("reader", index)));
    expect(pages.flatMap((page) => page.models.items.map((item) => item.id)))
      .toEqual(Array.from({ length: 105 }, (_, index) => id("model", index)));
    expect(pages.flatMap((page) => page.savedAgents.items.map((item) => item.agentId)))
      .toEqual(Array.from({ length: 76 }, (_, index) => id("saved", index)));
    expect(f.source.grantableOperations[0]?.toolName).toBe("reader_053");
  });

  it("marks shortened labels while retaining exact identities and full detail", async () => {
    const f = fixture(1, 1, 1);
    const longLabel = "A".repeat(400);
    f.source.grantableOperations[0] = { ...f.source.grantableOperations[0]!, label: longLabel };
    f.source.models[0] = { ...f.source.models[0]!, label: longLabel };
    f.source.savedAgents[0] = { ...f.source.savedAgents[0]!, title: longLabel };
    const page = await readAutomationAuthoringCatalogIndex(f.service, "draft-id", 0);
    expect(page.operations.items[0]).toMatchObject({ toolName: "reader_000",
      label: longLabel.slice(0, 160), labelTruncated: true });
    expect(page.models.items[0]).toMatchObject({ id: "model_000", labelTruncated: true });
    expect(page.models.items[0]?.label).toHaveLength(160);
    expect(page.savedAgents.items[0]).toMatchObject({ agentId: "saved_000", titleTruncated: true });
    expect(page.savedAgents.items[0]?.title).toHaveLength(160);
    const detail = await readAutomationAuthoringCatalogOperation(f.service, "draft-id", "reader_000", "read", 2);
    expect(detail.operation.label).toBe(longLabel);
  });

  it.each([-1, 0.5, NaN, Infinity, 2_147_483_648, "0", undefined])(
    "rejects invalid index offset %s before accessing the service", async (offset) => {
      const f = fixture();
      await expect(readAutomationAuthoringCatalogIndex(f.service, "draft-id", offset))
        .rejects.toThrow("automation_offset_invalid");
      expect(f.catalog).not.toHaveBeenCalled();
    },
  );

  it.each([0, 2_147_483_647])("returns explicit empty and past-end pages at %s", async (offset) => {
    const f = fixture(0, 0, 0);
    const page = await readAutomationAuthoringCatalogIndex(f.service, "draft-id", offset);
    expect(page.nextOffset).toBeNull();
    for (const collection of [page.operations, page.models, page.savedAgents]) {
      expect(collection).toEqual({ items: [], offset, totalCount: 0, omittedCount: 0, nextOffset: null });
    }
  });

  it("resolves exact current operation detail and excludes execution-only fixed params", async () => {
    const f = fixture(2);
    const before = structuredClone(f.source);
    const result = await readAutomationAuthoringCatalogOperation(f.service, "draft-id", "reader_001", "read", 2);
    expect(result).toMatchObject({ kind: "automation_authoring_catalog_operation_v1",
      catalogScope: { kind: "automation", automationId: "draft-id" },
      grantsPermissions: false, granted: false, operation: { toolName: "reader_001",
        operationId: "read", contractVersion: 2, input: f.source.grantableOperations[1]!.input,
        payload: f.source.grantableOperations[1]!.payload } });
    expect(result.operation).not.toHaveProperty("fixedParams");
    expect(result.permissions).toBe(AUTOMATION_AUTHORING_REFERENCE.permissions);
    expect(f.source).toEqual(before);
    expect((await readAutomationAuthoringCatalogOperation(f.service, "draft-id", "reader_000", "read", 2)).granted)
      .toBe(true);
  });

  it.each([["missing", "read", 2], ["reader_000", "missing", 2], ["reader_000", "read", 1]] as const)(
    "rejects missing or stale exact references %s/%s@%s", async (tool, operationId, version) => {
      const f = fixture(1);
      await expect(readAutomationAuthoringCatalogOperation(f.service, "draft-id", tool, operationId, version))
        .rejects.toThrow("automation_catalog_operation_not_found");
    },
  );

  it("rechecks catalog availability after an index was read", async () => {
    const f = fixture(1);
    await readAutomationAuthoringCatalogIndex(f.service, "draft-id", 0);
    f.source.grantableOperations.splice(0);
    await expect(readAutomationAuthoringCatalogOperation(f.service, "draft-id", "reader_000", "read", 2))
      .rejects.toThrow("automation_catalog_operation_not_found");
  });

  it("exposes discovery through the real registry while keeping legacy full catalog output", async () => {
    const f = fixture(2);
    const index = await f.registry.execute({ tool: "automations",
      params: { action: "browse_catalog", view: "index", automationId: "draft-id", offset: 0 } });
    expect(index.ok).toBe(true);
    expect(JSON.parse(index.output).operations.items).toHaveLength(2);
    const detail = await f.registry.execute({ tool: "automations", params: {
      action: "browse_catalog", view: "operation", automationId: "draft-id", toolName: "reader_001",
      operationId: "read", contractVersion: 2,
    } });
    expect(detail.ok).toBe(true);
    expect(JSON.parse(detail.output).operation.input).toEqual(f.source.grantableOperations[1]!.input);
    const legacy = await f.registry.execute({ tool: "automations",
      params: { action: "catalog", automationId: "draft-id" } });
    expect(legacy.ok).toBe(true);
    expect(JSON.parse(legacy.output)).toMatchObject({ kind: "automation_authoring_catalog_v1",
      grantsPermissions: false, operations: [{ input: expect.any(Object) }, { input: expect.any(Object) }] });
  });

  it("routes the model catalog contract to a bounded index without changing legacy direct calls", async () => {
    const f = fixture();
    const selected = automationDraftToolContract.operations.find(({ operationId }) => operationId === "catalog")!;
    expect(selected.fixedParams).toEqual({ action: "catalog", projection: "index" });
    expect(selected.selectionControlIds).toEqual(["automationId"]);
    const result = await f.registry.execute({ tool: "automations",
      params: { ...selected.fixedParams, automationId: "draft-id" } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({
      kind: "automation_authoring_catalog_index_v1", grantsPermissions: false,
      offset: 0, nextOffset: 50, operations: { totalCount: 54, omittedCount: 4 },
    });
    expect(JSON.parse(result.output).operations.items[0]).not.toHaveProperty("input");
    expect(result.data).toMatchObject({ mutationEvidence: false });
    const legacy = await f.registry.execute({ tool: "automations",
      params: { action: "catalog", automationId: "draft-id" } });
    expect(legacy.ok).toBe(true);
    expect(JSON.parse(legacy.output)).toEqual({
      kind: "automation_authoring_catalog_v1", grantsPermissions: false,
      catalogScope: { kind: "automation", automationId: "draft-id" },
      permissions: AUTOMATION_AUTHORING_REFERENCE.permissions,
      operations: f.source.grantableOperations.map(({ fixedParams: _fixed, ...operation }) => operation),
      grantedOperations: [{ toolName: "reader_000", operationId: "read", contractVersion: 2 }],
      models: f.source.models,
      savedAgents: [{ agentId: "saved_000", revision: 3, title: "Saved agent 0", modelProfileId: "model_000" }],
    });
  });

  it.each(["full", "unknown", "", null, 0, {}])("rejects an unsupported explicit catalog projection: %j", async (projection) => {
    const f = fixture();
    const result = await f.registry.execute({ tool: "automations",
      params: { action: "catalog", automationId: "draft-id", projection } });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("automation_catalog_projection_invalid");
    expect(f.catalog).not.toHaveBeenCalled();
  });

  it.each([
    { view: "full" }, {}, { view: "index", toolName: "reader_000" },
    { view: "operation", offset: 0, toolName: "reader_000", operationId: "read", contractVersion: 2 },
    { view: "operation" }, { view: "operation", toolName: "reader_000", operationId: "read" },
    { view: "operation", toolName: "reader_000", operationId: "read", contractVersion: "2" },
    { view: "operation", toolName: "reader_000", operationId: "read", contractVersion: 0 },
  ])("rejects malformed or mixed browsing views before catalog access: %j", async (params) => {
    const f = fixture();
    await expect(readAutomationAuthoringCatalog(f.service, { automationId: "draft-id", ...params }))
      .rejects.toThrow(/automation_catalog_/u);
    expect(f.catalog).not.toHaveBeenCalled();
  });

  it("discovers before a draft exists without inventing an automation identity", async () => {
    const f = fixture(2);
    const result = await f.registry.execute({ tool: "automations",
      params: { action: "browse_catalog", view: "index" } });
    expect(result.ok).toBe(true);
    expect(f.catalog).toHaveBeenCalledExactlyOnceWith("");
    expect(JSON.parse(result.output).catalogScope).toEqual({ kind: "pre_draft" });
    expect(JSON.parse(result.output).operations.items.map((entry: { ref: string }) => entry.ref))
      .toEqual(["reader_000/read@2", "reader_001/read@2"]);
    expect(result.data).toMatchObject({ mutationEvidence: false });
  });

  it.each(["", "   ", null, 0, "x".repeat(129)])(
    "rejects explicitly invalid automation identity %j before lookup", async (automationId) => {
      const f = fixture();
      await expect(readAutomationAuthoringCatalog(f.service, { view: "index", automationId }))
        .rejects.toThrow("automation_catalog_parameters_invalid");
      expect(f.catalog).not.toHaveBeenCalled();
    },
  );

  it("uses collision-free opaque refs for reserved characters", () => {
    expect(automationCatalogOperationRef({ toolName: "reader/a", operationId: "read@v", contractVersion: 2 }))
      .toBe("reader%2Fa/read%40v@2");
    expect(automationCatalogOperationRef({ toolName: "reader", operationId: "a/read@v", contractVersion: 2 }))
      .not.toBe("reader%2Fa/read%40v@2");
  });

  it("defaults only an omitted index offset to the first page", async () => {
    const f = fixture();
    const first = await readAutomationAuthoringCatalog(f.service, { automationId: "draft-id", view: "index" });
    expect(first).toMatchObject({ offset: 0, nextOffset: 50 });
    for (const offset of [-1, null]) {
      await expect(readAutomationAuthoringCatalog(f.service, {
        automationId: "draft-id", view: "index", offset,
      })).rejects.toThrow("automation_offset_invalid");
    }
    expect(f.catalog).toHaveBeenCalledTimes(1);
  });
});
