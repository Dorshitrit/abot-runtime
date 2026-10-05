import { describe, expect, it, vi } from "vitest";
import { parseToolNormalInvocationContract, validateToolNormalInvocationInput } from "../../capabilities/normal-invocation/validator.js";
import { AUTOMATION_CATALOG_OPERATION_REF_MAX_LENGTH, readAutomationAuthoringCatalogIndex } from "../capabilities/automations/authoring-catalog.js";
import type { AutomationCatalogOperation } from "../automations/catalog.js";
import type { AutomationService } from "../automations/service.js";
import { AUTOMATION_AUTHORING_REFERENCE } from "../capabilities/automation-builder/authoring-reference.js";
import { readAutomationAuthoringPreparation } from "../capabilities/automations/authoring-preparation.js";
import { createAutomationDraftToolModule } from "../capabilities/automations/tool-module.js";
import { createConfiguredToolRegistry } from "../capabilities/configured-tool-registry.js";

type Catalog = Awaited<ReturnType<AutomationService["catalog"]>>;
const operation = (name: string): AutomationCatalogOperation => ({
  toolName: name, operationId: "read", contractVersion: 2, label: `Read ${name}`,
  catalogGroups: ["files"], toolDescription: "Read a source.", permissionMode: "full_plus",
  effect: "read_only", approval: "request_policy", fixedParams: { action: "private_read" },
  input: { type: "object", additionalProperties: false,
    properties: { path: { type: "string", minLength: 1 } }, required: ["path"] },
});

function fixture(modelCount = 2, agentCount = 1) {
  const source: Catalog = {
    operations: [operation("reader_a")],
    grantableOperations: [operation("reader_a"), operation("reader_b")], templates: [],
    models: Array.from({ length: modelCount }, (_, i) => ({ id: `model_${String(i).padStart(3, "0")}`,
      label: `Model ${i}`, provider: "configured-provider" })),
    savedAgents: Array.from({ length: agentCount }, (_, i) => ({ id: `saved_${String(i).padStart(3, "0")}`,
      revision: 3, title: `Saved ${i}`, modelProfileId: "model_000", agent: { id: `agent_${i}`,
        kind: "agent", title: "Saved", onFailure: "stop", modelProfileId: "model_000",
        agentMode: "fast", roleInstructions: "Private role", prompt: "Private prompt",
        inputs: {}, tools: [], result: { kind: "text" } } })),
  };
  const service = { catalog: vi.fn(async () => source) };
  const module = createAutomationDraftToolModule(() => service as unknown as AutomationService,
    async () => undefined);
  return { source, service, module, registry: createConfiguredToolRegistry(undefined, [module]) };
}

describe("automation authoring preparation", () => {
  it("resolves multiple selected schemas from one canonical snapshot without creating or authorizing anything", async () => {
    const f = fixture();
    const before = structuredClone(f.source);
    const result = await readAutomationAuthoringPreparation(f.service, {
      operationRefs: ["reader_b/read@2", "reader_a/read@2"],
    });
    expect(f.service.catalog).toHaveBeenCalledExactlyOnceWith("");
    expect(result).toMatchObject({ kind: "automation_authoring_preparation_v1",
      authority: "runtime_registry", catalogScope: { kind: "pre_draft" },
      grantsPermissions: false, executesWorkflow: false });
    expect(result.operations.map(({ ref }) => ref)).toEqual(["reader_b/read@2", "reader_a/read@2"]);
    expect(result.operations.map(({ granted }) => granted)).toEqual([false, true]);
    expect(result.operations[0]?.input).toEqual(f.source.grantableOperations[1]?.input);
    for (const entry of result.operations) expect(entry).not.toHaveProperty("fixedParams");
    expect(result.authoringReference).toBe(AUTOMATION_AUTHORING_REFERENCE);
    expect(result).not.toHaveProperty("permissions");
    expect(result.authoringReference.permissions).toBe(AUTOMATION_AUTHORING_REFERENCE.permissions);
    expect(result.models.items.map(({ id }) => id)).toEqual(["model_000", "model_001"]);
    expect(result.savedAgents.items[0]).not.toHaveProperty("agent");
    expect(JSON.stringify(result)).not.toContain("Private prompt");
    expect(f.source).toEqual(before);
  });

  it("round-trips maximum-length legal Unicode identities through discovery and preparation", async () => {
    const f = fixture();
    const unicode = { ...operation("界".repeat(64)), operationId: "ש".repeat(64), contractVersion: 1 };
    expect(() => parseToolNormalInvocationContract(unicode.toolName, { version: 1,
      operations: [{ operationId: unicode.operationId, summary: unicode.label, input: unicode.input,
        effect: unicode.effect, approval: unicode.approval }] })).not.toThrow();
    f.source.grantableOperations = [unicode];
    f.source.operations = [];
    const page = await readAutomationAuthoringCatalogIndex(f.service, "", 0);
    const ref = page.operations.items[0]!.ref;
    expect(ref.length).toBeGreaterThan(256);
    expect(ref.length).toBeLessThanOrEqual(AUTOMATION_CATALOG_OPERATION_REF_MAX_LENGTH);
    const selected = f.module.normalInvocation!.operations.find(({ operationId }) => operationId === "prepare_draft")!;
    expect(validateToolNormalInvocationInput(selected, { operationRefs: [ref] })).toMatchObject({ ok: true });
    const result = await f.registry.execute({ tool: "automations",
      params: { action: "prepare_draft", operationRefs: [ref] } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output).operations[0]).toMatchObject({
      ref, toolName: unicode.toolName, operationId: unicode.operationId, contractVersion: 1,
    });
  });

  it("permits preparation for an agent-only draft and reports scoped existing grants", async () => {
    const f = fixture();
    const empty = await readAutomationAuthoringPreparation(f.service, { operationRefs: [] });
    expect(empty.operations).toEqual([]);
    const scoped = await readAutomationAuthoringPreparation(f.service, {
      automationId: "existing-draft", operationRefs: ["reader_a/read@2"],
    });
    expect(empty.catalogScope).toEqual({ kind: "pre_draft" });
    expect(scoped.catalogScope).toEqual({ kind: "automation", automationId: "existing-draft" });
    expect(scoped.operations[0]?.granted).toBe(true);
    expect(scoped.authoringReference.permissions).toBe(AUTOMATION_AUTHORING_REFERENCE.permissions);
    expect(f.service.catalog.mock.calls).toEqual([[""], ["existing-draft"]]);
  });

  it("exposes one mechanically complete read-only operation through the real registry", async () => {
    const f = fixture();
    const selected = f.module.normalInvocation!.operations.find(({ operationId }) => operationId === "prepare_draft")!;
    expect(selected.effect).toBe("read_only");
    expect(selected.selectionControlIds).toEqual(Object.keys(selected.input.properties));
    expect(selected.input.required).toEqual(["operationRefs"]);
    const result = await f.registry.execute({ tool: "automations",
      params: { ...selected.fixedParams, operationRefs: ["reader_b/read@2"] } });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output).operations).toHaveLength(1);
    expect(result.data).toMatchObject({ mutationEvidence: false });
    expect(f.service.catalog).toHaveBeenCalledExactlyOnceWith("");
  });

  it.each([undefined, null, "reader_a/read@2", [null], [1], [""], [" reader_a/read@2"],
    ["x".repeat(AUTOMATION_CATALOG_OPERATION_REF_MAX_LENGTH + 1)], Array.from({ length: 17 }, (_, i) => `reader_${i}/read@2`)]
    .map((operationRefs) => ({ operationRefs })))(
    "rejects invalid or excessive refs before catalog access: %j", async ({ operationRefs }) => {
      const f = fixture();
      await expect(readAutomationAuthoringPreparation(f.service, { operationRefs }))
        .rejects.toThrow("automation_preparation_operation_refs_invalid");
      expect(f.service.catalog).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate refs without reading or performing an operation", async () => {
    const f = fixture();
    await expect(readAutomationAuthoringPreparation(f.service, {
      operationRefs: ["reader_a/read@2", "reader_a/read@2"],
    })).rejects.toThrow("automation_preparation_duplicate_operation_ref");
    expect(f.service.catalog).not.toHaveBeenCalled();
  });

  it.each(["missing/read@2", "reader_a/read@1", "reader_a/missing@2"])(
    "rejects unknown or stale exact refs: %s", async (ref) => {
      const f = fixture();
      await expect(readAutomationAuthoringPreparation(f.service, { operationRefs: [ref] }))
        .rejects.toThrow("automation_catalog_operation_not_found");
      expect(f.service.catalog).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["", "   ", null, 0, "x".repeat(129)])(
    "rejects invalid explicit draft identity %j before reading", async (automationId) => {
      const f = fixture();
      await expect(readAutomationAuthoringPreparation(f.service, { automationId, operationRefs: [] }))
        .rejects.toThrow("automation_catalog_parameters_invalid");
      expect(f.service.catalog).not.toHaveBeenCalled();
    },
  );

  it("declares bounded models and saved agents without truncating selected schemas", async () => {
    const f = fixture(52, 53);
    const result = await readAutomationAuthoringPreparation(f.service, { operationRefs: ["reader_a/read@2"] });
    expect(result.models).toMatchObject({ totalCount: 52, omittedCount: 2, nextOffset: 50 });
    expect(result.savedAgents).toMatchObject({ totalCount: 53, omittedCount: 3, nextOffset: 50 });
    expect(result.models.items).toHaveLength(50);
    expect(result.savedAgents.items).toHaveLength(50);
    expect(result.operations[0]?.input).toEqual(f.source.grantableOperations[0]?.input);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(result.maxBytes);
  });

  it("rejects oversized selected detail rather than silently truncating it", async () => {
    const f = fixture();
    f.source.grantableOperations[0] = { ...f.source.grantableOperations[0]!,
      toolDescription: "long detail ".repeat(10_000) };
    await expect(readAutomationAuthoringPreparation(f.service, { operationRefs: ["reader_a/read@2"] }))
      .rejects.toThrow("automation_preparation_output_too_large");
    expect(f.service.catalog).toHaveBeenCalledTimes(1);
  });
});
