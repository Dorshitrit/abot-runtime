import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function catalog(id: string, environment: string) {
  return { operations: [{ toolName: `${environment}/${id}` }], models: [],
    savedAgents: [{ agentId: `${environment}/${id}` }] };
}

function fixture() {
  let environment = "dev";
  const render = vi.fn();
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async () => ({ automations: [{ id: "one" }, { id: "two" }] })),
    getAutomationCatalog: vi.fn(async (id: string, env: string) => catalog(id, env)),
    getAutomationDraft: vi.fn(async (id: string, env: string) => ({ draft: { automationId: id,
      revision: 3, definition: { title: `${env}/${id}`, body: { kind: "sequence", id: "root",
        children: [{ kind: "agent", id: "agent-one", title: "Agent" }] } } } })),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    saveAutomationAgent: vi.fn(async (_id: string, _node: string, _revision: number, _env: string) =>
      ({ agent: { agentId: "saved-agent", revision: 2 } })),
  };
  const controller = createAutomationsController({ client, getEnvironmentId: () => environment,
    render, isVisible: () => true });
  return { client, controller, render, setEnvironment(value: string) { environment = value; } };
}

async function openAgent(f: ReturnType<typeof fixture>) {
  await f.controller.openRoute("one");
  f.controller.selectNode("agent-one");
}

async function navigate(f: ReturnType<typeof fixture>, destination: string) {
  switch (destination) {
    case "another environment":
      f.setEnvironment("prod");
      f.controller.environmentChanged();
      await f.controller.openRoute("one");
      break;
    case "away and back":
      await f.controller.openRoute("two");
      await f.controller.openRoute("one");
      break;
    default:
      await f.controller.openRoute("two");
  }
  f.controller.selectNode("agent-one");
  await f.controller.saveDefinition({ title: f.controller.snapshot().draft.definition.title });
}

const navigationCases = ["another automation", "another environment", "away and back"]
  .flatMap((destination) => ["success", "failure"].map((outcome) => ({ destination, outcome })));

describe("saved-agent view ownership", () => {
  test.each(navigationCases)("discards save $outcome after $destination", async ({ destination, outcome }) => {
    const f = fixture();
    await openAgent(f);
    const held = deferred<Awaited<ReturnType<typeof f.client.saveAutomationAgent>>>();
    f.client.saveAutomationAgent.mockImplementationOnce(() => held.promise);
    const saving = f.controller.saveAgent();
    expect(f.client.saveAutomationAgent).toHaveBeenCalledExactlyOnceWith("one", "agent-one", 3, "dev");
    await navigate(f, destination);
    const before = f.controller.snapshot();
    const catalogCalls = f.client.getAutomationCatalog.mock.calls.length;
    if (outcome === "success") held.resolve({ agent: { agentId: "old-agent", revision: 9 } });
    else held.reject(new Error("Old save failed"));
    expect(await saving).toBe(false);
    expect(f.controller.snapshot()).toEqual({ ...before, mutation: "" });
    expect(f.client.getAutomationCatalog).toHaveBeenCalledTimes(catalogCalls);
  });

  test.each(navigationCases)("discards catalog $outcome after $destination", async ({ destination, outcome }) => {
    const f = fixture();
    await openAgent(f);
    const held = deferred<ReturnType<typeof catalog>>();
    f.client.getAutomationCatalog.mockImplementationOnce(() => held.promise);
    const saving = f.controller.saveAgent();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(f.client.getAutomationCatalog).toHaveBeenLastCalledWith("one", "dev");
    expect(f.client.getAutomationCatalog).toHaveBeenCalledTimes(3);
    await navigate(f, destination);
    const before = f.controller.snapshot();
    const renders = f.render.mock.calls.length;
    if (outcome === "success") held.resolve(catalog("old-one", "dev"));
    else held.reject(new Error("Old catalog failed"));
    expect(await saving).toBe(false);
    expect(f.controller.snapshot()).toEqual(before);
    expect(f.render).toHaveBeenCalledTimes(renders);
  });

  test("uses the captured environment even before an environment-reset notification", async () => {
    const f = fixture();
    await openAgent(f);
    const held = deferred<Awaited<ReturnType<typeof f.client.saveAutomationAgent>>>();
    f.client.saveAutomationAgent.mockImplementationOnce(() => held.promise);
    const saving = f.controller.saveAgent();
    const before = f.controller.snapshot();
    f.setEnvironment("prod");
    held.resolve({ agent: { agentId: "old-agent", revision: 9 } });
    expect(await saving).toBe(false);
    expect(f.controller.snapshot()).toEqual({ ...before, mutation: "" });
    expect(f.client.getAutomationCatalog).toHaveBeenCalledTimes(2);
  });

  test("a current save refreshes its catalog and reports the saved revision", async () => {
    const f = fixture();
    await openAgent(f);
    const updated = catalog("saved-one", "dev");
    f.client.getAutomationCatalog.mockResolvedValueOnce(updated);
    expect(await f.controller.saveAgent()).toBe(true);
    expect(f.client.saveAutomationAgent).toHaveBeenCalledExactlyOnceWith("one", "agent-one", 3, "dev");
    expect(f.client.getAutomationCatalog).toHaveBeenLastCalledWith("one", "dev");
    expect(f.controller.snapshot()).toMatchObject({ catalog: updated,
      feedback: "Saved agent · revision 2.", error: "", mutation: "" });
  });

  test.each(["success", "failure"])("an older catalog %s cannot replace a newer save in the same view", async (outcome) => {
    const f = fixture();
    await openAgent(f);
    const older = deferred<ReturnType<typeof catalog>>();
    const newer = deferred<ReturnType<typeof catalog>>();
    f.client.getAutomationCatalog.mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    f.client.saveAutomationAgent.mockResolvedValueOnce({ agent: { agentId: "old-agent", revision: 2 } })
      .mockResolvedValueOnce({ agent: { agentId: "new-agent", revision: 3 } });
    const olderSave = f.controller.saveAgent();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(f.client.getAutomationCatalog).toHaveBeenCalledTimes(3);
    const newerSave = f.controller.saveAgent();
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(f.client.getAutomationCatalog).toHaveBeenCalledTimes(4);
    newer.resolve(catalog("newest", "dev"));
    expect(await newerSave).toBe(true);
    const before = f.controller.snapshot();
    const renders = f.render.mock.calls.length;
    if (outcome === "success") older.resolve(catalog("stale", "dev"));
    else older.reject(new Error("Old catalog failed"));
    expect(await olderSave).toBe(false);
    expect(f.controller.snapshot()).toEqual(before);
    expect(f.controller.snapshot()).toMatchObject({ catalog: catalog("newest", "dev"),
      feedback: "Saved agent · revision 3.", error: "", mutation: "" });
    expect(f.render).toHaveBeenCalledTimes(renders);
  });

  test("a current save failure remains visible and does not fetch a catalog", async () => {
    const f = fixture();
    await openAgent(f);
    const before = f.controller.snapshot().catalog;
    f.client.saveAutomationAgent.mockRejectedValueOnce(new Error("Save failed"));
    expect(await f.controller.saveAgent()).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ catalog: before, error: "Save failed", mutation: "" });
    expect(f.client.getAutomationCatalog).toHaveBeenCalledTimes(2);
  });

  test("a current refresh failure preserves the catalog and still confirms the completed save", async () => {
    const f = fixture();
    await openAgent(f);
    const before = f.controller.snapshot().catalog;
    f.client.getAutomationCatalog.mockRejectedValueOnce(new Error("Catalog failed"));
    expect(await f.controller.saveAgent()).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ catalog: before,
      feedback: "Saved agent · revision 2.",
      error: "Agent saved, but the palette could not refresh: Catalog failed", mutation: "" });
  });
});
