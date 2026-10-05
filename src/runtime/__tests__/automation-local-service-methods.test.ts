import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnvironmentServices } from "../composition.js";
import { createLocalServiceClients } from "../local-host/client-services.js";
import { dispatchLocalServiceCall } from "../local-host/app-service-dispatch.js";
import { LOCAL_AUTOMATION_METHODS } from "../local-host/app-service-dispatch.js";
import { createAutomationService } from "../automations/service.js";
import type { RuntimeConfig, ToolRegistry } from "../ports.js";
import type { SchedulerService } from "../scheduler/contracts.js";
import type { AutomationPersistence } from "../automations/persistence.js";
import type { AutomationResultStore } from "../automations/result-store.js";

describe("ABot Studio local service bridge", () => {
  it("proxies every automation facade method", () => {
    const facade = createAutomationService({
      config: { runtimeId: "dev" } as RuntimeConfig,
      scheduler: {
        listAutomationRuns: async () => [],
        stopAutomationRun: async () => undefined,
      } as unknown as SchedulerService,
      persistence: {} as AutomationPersistence,
      results: {} as AutomationResultStore,
      tools: {} as ToolRegistry,
    });
    expect([...LOCAL_AUTOMATION_METHODS].sort()).toEqual(Object.keys(facade).sort());
    const clients = createLocalServiceClients(async () => undefined);
    expect(Object.keys(clients.automations).sort()).toEqual(Object.keys(facade).sort());
  });

  it("proxies published-definition reads through the managed runtime", async () => {
    const definition = { automationId: "automation-1", revision: 2 };
    const getPublishedDefinition = vi.fn(async () => definition);
    const services = { automations: { getPublishedDefinition } } as unknown as RuntimeEnvironmentServices;
    const client = createLocalServiceClients((method, args) =>
      dispatchLocalServiceCall(services, method, args));

    await expect(client.automations.getPublishedDefinition("automation-1"))
      .resolves.toEqual(definition);
    expect(getPublishedDefinition).toHaveBeenCalledExactlyOnceWith("automation-1");
  });

  it("forwards draft deletion and its revision to the owner", async () => {
    const deleteDraft = vi.fn(async () => undefined);
    const services = { automations: { deleteDraft } } as unknown as RuntimeEnvironmentServices;
    const client = createLocalServiceClients((method, args) =>
      dispatchLocalServiceCall(services, method, args));

    await client.automations.deleteDraft("draft-one", 2);

    expect(deleteDraft).toHaveBeenCalledExactlyOnceWith("draft-one", 2);
  });

  it("preserves owner rejection for a stale draft revision", async () => {
    const deleteDraft = vi.fn(async () => {
      throw new Error("automation_revision_conflict");
    });
    const services = { automations: { deleteDraft } } as unknown as RuntimeEnvironmentServices;
    const client = createLocalServiceClients((method, args) =>
      dispatchLocalServiceCall(services, method, args));

    await expect(client.automations.deleteDraft("draft-one", 1))
      .rejects.toThrow("automation_revision_conflict");
    expect(deleteDraft).toHaveBeenCalledExactlyOnceWith("draft-one", 1);
  });

  it("forwards atomic plans and receipts unchanged and preserves revision rejection", async () => {
    const plan = { version: 1, commands: [{ mutation: {
      kind: "update_definition", patch: { objective: "Future work" },
    } }] };
    const receipt = { draft: { automationId: "draft-one", revision: 2 }, aliases: { root: "exact-root" } };
    const createDraftPlan = vi.fn(async () => receipt);
    const applyDraftPlan = vi.fn(async (_id: string, revision: number) => {
      if (revision !== 1) throw new Error("automation_revision_conflict");
      return receipt;
    });
    const services = { automations: { createDraftPlan, applyDraftPlan } } as unknown as RuntimeEnvironmentServices;
    const client = createLocalServiceClients((method, args) => dispatchLocalServiceCall(services, method, args));
    await expect(client.automations.createDraftPlan("New draft", plan)).resolves.toEqual(receipt);
    expect(createDraftPlan).toHaveBeenCalledExactlyOnceWith("New draft", plan);
    await expect(client.automations.applyDraftPlan("draft-one", 1, plan)).resolves.toEqual(receipt);
    expect(applyDraftPlan).toHaveBeenCalledExactlyOnceWith("draft-one", 1, plan);
    await expect(client.automations.applyDraftPlan("draft-one", 2, plan))
      .rejects.toThrow("automation_revision_conflict");
  });
});
