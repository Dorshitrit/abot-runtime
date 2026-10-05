import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function draft(automationId: string, environment: string, revision = 1) {
  return { draft: { automationId, revision, definition: { automationId,
    title: `${environment}/${automationId}`, body: { kind: "sequence", id: "root", children: [
      { kind: "agent", id: `${environment}-${automationId}-${revision}`, title: "Agent" },
    ] } } }, validation: { issues: [{ code: "check", message: `${environment}/${automationId}` }] } };
}

const change = { kind: "add_node", parentSequenceId: "root", index: 0,
  nodeWithoutId: { kind: "agent", title: "New agent" } };

function fixture() {
  let environment = "dev";
  const render = vi.fn();
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async (_environment: string) => ({ automations: [{ id: "one" }, { id: "two" }] })),
    getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
    getAutomationDraft: vi.fn(async (id: string, env: string) => draft(id, env)),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    mutateAutomationDraft: vi.fn(async (id: string, revision: number, _change: unknown, env: string) =>
      draft(id, env, revision + 1)),
  };
  const controller = createAutomationsController({ client, getEnvironmentId: () => environment,
    render, isVisible: () => true });
  return { client, controller, render, setEnvironment(value: string) { environment = value; } };
}

async function navigate(f: ReturnType<typeof fixture>, destination: string) {
  if (destination === "another automation") {
    await f.controller.openRoute("two");
    return;
  }
  if (destination === "same automation in another environment") {
    f.setEnvironment("prod");
    f.controller.environmentChanged();
    await f.controller.openRoute("one");
    return;
  }
  await f.controller.openRoute("two");
  await f.controller.openRoute("one");
}

describe("draft mutation view ownership", () => {
  test.each(["another automation", "same automation in another environment", "away and back"])(
    "ignores late success after navigating to %s", async (destination) => {
      const f = fixture();
      await f.controller.openRoute("one");
      const held = deferred<ReturnType<typeof draft>>();
      f.client.mutateAutomationDraft.mockImplementationOnce(() => held.promise);
      const saving = f.controller.mutateDraft(change);
      expect(f.client.mutateAutomationDraft).toHaveBeenCalledExactlyOnceWith("one", 1, change, "dev");
      await navigate(f, destination);
      const currentDraft = f.controller.snapshot().draft;
      f.controller.selectNode(currentDraft.definition.body.children[0].id);
      await f.controller.saveDefinition({ title: currentDraft.definition.title });
      const before = f.controller.snapshot();
      const listCalls = f.client.listAutomations.mock.calls.length;
      held.resolve(draft("one", "dev", 2));
      expect(await saving).toBe(false);
      expect(f.controller.snapshot()).toMatchObject({
        selectedAutomationId: before.selectedAutomationId, selectedNodeId: before.selectedNodeId,
        draft: before.draft, validation: before.validation, feedback: before.feedback,
        error: "", mutation: "",
      });
      expect(f.client.listAutomations).toHaveBeenCalledTimes(listCalls);
    },
  );

  test.each(["another automation", "same automation in another environment", "away and back"])(
    "ignores late failure after navigating to %s", async (destination) => {
      const f = fixture();
      await f.controller.openRoute("one");
      const held = deferred<ReturnType<typeof draft>>();
      f.client.mutateAutomationDraft.mockImplementationOnce(() => held.promise);
      const saving = f.controller.mutateDraft(change);
      await navigate(f, destination);
      const before = f.controller.snapshot();
      const listCalls = f.client.listAutomations.mock.calls.length;
      held.reject(new Error("Old draft could not be saved"));
      expect(await saving).toBe(false);
      expect(f.controller.snapshot()).toMatchObject({ draft: before.draft,
        validation: before.validation, error: "", feedback: before.feedback, mutation: "" });
      expect(f.client.listAutomations).toHaveBeenCalledTimes(listCalls);
    },
  );

  test("captures the environment even before an environment-reset notification", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    const held = deferred<ReturnType<typeof draft>>();
    f.client.mutateAutomationDraft.mockImplementationOnce(() => held.promise);
    const saving = f.controller.mutateDraft(change);
    const before = f.controller.snapshot();
    f.setEnvironment("prod");
    held.resolve(draft("one", "dev", 2));
    expect(await saving).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ draft: before.draft,
      validation: before.validation, feedback: "", mutation: "" });
    expect(f.client.listAutomations).toHaveBeenCalledTimes(1);
  });

  test("keeps the busy lock until settlement, then preserves a newly started mutation", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    const oldSave = deferred<ReturnType<typeof draft>>();
    const nextSave = deferred<ReturnType<typeof draft>>();
    f.client.mutateAutomationDraft.mockImplementationOnce(() => oldSave.promise)
      .mockImplementationOnce(() => nextSave.promise);
    const saving = f.controller.mutateDraft(change);
    await navigate(f, "same automation in another environment");
    expect(f.controller.snapshot().mutation).toBe("Draft");
    expect(await f.controller.mutateDraft(change)).toBe(false);
    expect(f.client.mutateAutomationDraft).toHaveBeenCalledTimes(1);
    let nextSaving: Promise<boolean> | undefined;
    f.render.mockImplementationOnce(() => {
      expect(f.controller.snapshot().mutation).toBe("");
      nextSaving = f.controller.mutateDraft(change);
    });
    oldSave.resolve(draft("one", "dev", 2));
    expect(await saving).toBe(false);
    expect(f.controller.snapshot().mutation).toBe("Draft");
    expect(f.client.mutateAutomationDraft).toHaveBeenLastCalledWith("one", 1, change, "prod");
    nextSave.resolve(draft("one", "prod", 2));
    expect(await nextSaving).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ mutation: "", draft: { revision: 2,
      definition: { title: "prod/one" } } });
  });

  test("a current success updates the draft, selects the new node and reloads its list", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    expect(await f.controller.mutateDraft(change)).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ draft: draft("one", "dev", 2).draft,
      selectedNodeId: "dev-one-2", validation: null, validationVisible: false,
      error: "", feedback: "Draft saved.", mutation: "" });
    expect(f.client.listAutomations).toHaveBeenCalledTimes(2);
  });

  test("a current error stays visible without replacing the draft or reloading", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    f.client.mutateAutomationDraft.mockRejectedValueOnce(Object.assign(new Error("Revision changed"),
      { code: "automation_revision_conflict" }));
    expect(await f.controller.mutateDraft(change)).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ draft: draft("one", "dev").draft,
      error: "automation_revision_conflict · Revision changed", feedback: "", mutation: "" });
    expect(f.client.listAutomations).toHaveBeenCalledTimes(1);
  });
});
