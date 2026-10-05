import { describe, expect, test, vi } from "vitest";
import { createAutomationService } from "../automations/service.js";
import { createAutomationDraftManager } from "../automations/draft-management.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import type { AutomationResultStore } from "../automations/result-store.js";
import { emptyAutomationJournalState } from "../automations/storage-records.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type { SchedulerService } from "../scheduler/contracts.js";
import { createAutomationRequests } from "../../web-ui/app/services/runtime-web-client/automations.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationTemplateGallery } from "../../web-ui/app/components/automations/template-gallery.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function persistenceFixture(): AutomationPersistence {
  let state = emptyAutomationJournalState();
  return {
    read: async () => structuredClone(state),
    update: async (mutate) => {
      const next = structuredClone(state);
      const result = mutate(next);
      state = next;
      return result;
    },
    updateWithScheduler: async () => { throw new Error("unexpected_scheduler_mutation"); },
  };
}

function registration(toolName: string, operationId: string, effect = "read_only",
  properties: Record<string, unknown> = {}) {
  return {
    toolName,
    definition: { catalogGroups: ["read"], requiredPermissionMode: "full_access" },
    contract: { version: 7, operations: [{ operationId, summary: "Read bounded data",
      effect, approval: "request_policy", input: { type: "object", additionalProperties: false,
        properties, required: [] } }, { kind: "agent", modelProfileId: "", tools: [] }] },
  };
}

function serviceFixture() {
  const persistence = persistenceFixture();
  let registrations = [registration("system_probe", "inspect_system_state")];
  const service = createAutomationService({
    config: { runtimeId: "dev", models: { profiles: {} } } as RuntimeConfig,
    scheduler: { listAutomationRuns: async () => [], stopAutomationRun: async () => null } as unknown as SchedulerService,
    persistence,
    results: {} as AutomationResultStore,
    tools: { listNormalInvocations: () => registrations } as unknown as ToolRegistry,
  });
  return { service, persistence, setRegistrations: (next: typeof registrations) => { registrations = next; } };
}

describe("ABot Studio starter templates", () => {
  test("does not persist a draft if template materialization fails", async () => {
    const persistence = persistenceFixture();
    const manager = createAutomationDraftManager({ persistence });
    await expect(manager.create("Starter", () => { throw new Error("invalid_starter"); }))
      .rejects.toThrow("invalid_starter");
    expect((await persistence.read()).drafts).toEqual([]);
  });

  test("offers only configured operations and creates the multi-step draft atomically", async () => {
    const { service, persistence, setRegistrations } = serviceFixture();
    const catalog = await service.catalog("");
    expect(catalog.templates?.map((item) => item.id)).toEqual(["machine-health"]);
    expect((await service.catalog("another-automation")).templates).toEqual([]);

    const draft = await service.create("Ignored title", "machine-health");
    expect(draft).toMatchObject({ revision: 1, definition: {
      title: "Machine health review", trigger: { kind: "manual" },
      body: { children: [{ kind: "tool", operation: {
        toolName: "system_probe", operationId: "inspect_system_state", contractVersion: 7,
      } }, { kind: "agent", modelProfileId: "", tools: [] }] },
    } });
    expect((await persistence.read()).grants).toEqual([]);
    expect((await persistence.read()).definitions).toEqual([]);

    setRegistrations([]);
    await expect(service.create("Ignored", "machine-health"))
      .rejects.toThrow("automation_template_unavailable");
    expect((await persistence.read()).drafts).toHaveLength(1);
  });

  test("binds a model step to the exact selected tool result without choosing a model", async () => {
    const { service, setRegistrations } = serviceFixture();
    setRegistrations([registration("system_probe", "inspect_system_state")]);
    const draft = await service.create("Ignored", "machine-health");
    const [source, reader] = draft.definition.body.children;
    expect(source).toMatchObject({ kind: "tool", operation: { contractVersion: 7 } });
    expect(reader).toMatchObject({ kind: "agent", modelProfileId: "", tools: [],
      inputs: { machine: { kind: "node_result", nodeId: source?.id, select: "text" } } });
    expect(draft.revision).toBe(1);
  });

  test("does not offer a template after its operation becomes mutating", async () => {
    const { service, setRegistrations } = serviceFixture();
    setRegistrations([registration("system_probe", "inspect_system_state", "mutating")]);
    expect((await service.catalog("")).templates).toEqual([]);
    await expect(service.create("Ignored", "machine-health"))
      .rejects.toThrow("automation_template_unavailable");
  });

  test("hides a starter when its preset inputs no longer fit the tool contract", async () => {
    const { service, setRegistrations } = serviceFixture();
    setRegistrations([registration("local_search", "search_local_files", "read_only",
      { max_results: { type: "integer", minimum: 1, maximum: 3 } })]);
    expect((await service.catalog("")).templates).toEqual([]);
    await expect(service.create("Ignored", "local-search-brief"))
      .rejects.toThrow("automation_template_unavailable");
  });

  test("shows eligible template cards and sends the selected ID", async () => {
    const { service } = serviceFixture();
    const templateCatalog = await service.catalog("");
    const markup = renderAutomationTemplateGallery({ automations: [], templateCatalog,
      templateCatalogError: "", loading: false, error: "" });
    expect(markup).toContain('data-template-id="machine-health"');
    expect(markup).toContain("Choose a model. Review the machine scope before granting and running.");
    expect(markup).not.toContain('data-template-id="local-search-brief"');
    expect(markup).toContain("2 steps");

    const requestApi = vi.fn(async () => ({ draft: { automationId: "new-id", revision: 1 } }));
    const client = createAutomationRequests({ requestApi, getEnvironmentId: () => "dev",
      getConfig: () => ({ backend: "runtime" }) });
    await client.createAutomation("dev", "machine-health");
    expect(requestApi).toHaveBeenCalledWith("/automations?environment=dev", {
      method: "POST", body: '{"templateId":"machine-health"}',
    });
  });

  test("opens the chosen template as an editable draft without publishing or granting", async () => {
    const { service } = serviceFixture();
    const listCatalog = await service.catalog("");
    const createdDraft = await service.create("Ignored", "machine-health");
    let automations: Array<{ id: string; title: string }> = [];
    const client = {
      supportsAutomations: () => true,
      listAutomations: vi.fn(async () => ({ automations })),
      getAutomationCatalog: vi.fn(async (id: string) => id ? { operations: [], models: [], savedAgents: [] } : listCatalog),
      createAutomation: vi.fn(async () => {
        automations = [{ id: createdDraft.automationId, title: createdDraft.definition.title }];
        return { draft: createdDraft };
      }),
      getAutomationDraft: vi.fn(async () => ({ draft: createdDraft, publishedDefinition: null, grant: null })),
      listAutomationRuns: vi.fn(async () => ({ runs: [] })),
      publishAutomation: vi.fn(),
      setAutomationPermission: vi.fn(),
    };
    const controller = createAutomationsController({ client, getEnvironmentId: () => "dev",
      render: () => {}, isVisible: () => true });
    await controller.openRoute("");
    expect(controller.snapshot().templateCatalog.templates).toHaveLength(1);
    expect(await controller.createTemplate("machine-health")).toBe(true);
    expect(client.createAutomation).toHaveBeenCalledExactlyOnceWith("dev", "machine-health");
    expect(controller.snapshot()).toMatchObject({ selectedAutomationId: createdDraft.automationId,
      draft: { revision: 1, definition: { title: "Machine health review" } } });
    expect(client.publishAutomation).not.toHaveBeenCalled();
    expect(client.setAutomationPermission).not.toHaveBeenCalled();
  });
});
