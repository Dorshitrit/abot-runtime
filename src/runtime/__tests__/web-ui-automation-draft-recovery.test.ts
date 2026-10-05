import { describe, expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
import type { AutomationRevision, WorkflowNode } from "../automations/definition-contracts.js";
import { applyDraftMutation, createEmptyAutomationDefinition, parseDraftMutation } from "../automations/draft-mutations.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationDraftRecoveryCommands, renderAutomationDraftRecovery } from "../../web-ui/app/components/automations/draft-recovery-actions.js";

const tool = (id: string): WorkflowNode => ({ id, kind: "tool", title: id, onFailure: "stop",
  operation: { toolName: "example", operationId: "read", contractVersion: 1 }, controls: {} });
const move = (nodeId: string, index: number, parentSequenceId = "root") =>
  ({ kind: "move_node", nodeId, parentSequenceId, index });

function fixture(children: WorkflowNode[] = [tool("a"), tool("b"), tool("c")]) {
  let environment = "dev";
  const initial: AutomationRevision = { ...createEmptyAutomationDefinition("one", "Workflow"),
    body: { kind: "sequence", id: "root", children } };
  const published = structuredClone(initial);
  const server = { draft: { automationId: "one", revision: 1, definition: initial } };
  const write = async (id: string, revision: number, change: unknown, _environment: string) => {
    if (id !== "one" || revision !== server.draft.revision) throw new Error("automation_revision_conflict");
    const definition = applyDraftMutation(server.draft.definition, parseDraftMutation(change));
    server.draft = { automationId: id, revision: definition.revision, definition };
    return structuredClone(server);
  };
  const client = {
    supportsAutomations: () => true,
    listAutomations: vi.fn(async () => ({ automations: [{ id: "one", publishedRevision: 1, status: "paused" }] })),
    getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
    getAutomationDraft: vi.fn(async () => ({ ...structuredClone(server), publishedDefinition: structuredClone(published) })),
    listAutomationRuns: vi.fn(async () => ({ runs: [] })),
    mutateAutomationDraft: vi.fn(write),
  };
  const controller = createAutomationsController({ client, getEnvironmentId: () => environment,
    render: vi.fn(), isVisible: () => true });
  return { client, controller, server, published, write,
    order: () => server.draft.definition.body.children.map((node) => node.id),
    setEnvironment: (value: string) => { environment = value; } };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("revisioned draft recovery", () => {
  test("undoes earlier and later moves through the canonical API with monotonically increasing revisions", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    await f.controller.mutateDraft(move("a", 2));
    await f.controller.mutateDraft(move("c", 0));
    expect(f.order()).toEqual(["c", "b", "a"]);
    expect(f.controller.snapshot().draftUndo.count).toBe(2);
    expect(await f.controller.undoDraftMove()).toBe(true);
    expect(f.order()).toEqual(["b", "a", "c"]);
    expect(f.client.mutateAutomationDraft).toHaveBeenLastCalledWith("one", 3, move("c", 3), "dev");
    expect(await f.controller.undoDraftMove()).toBe(true);
    expect(f.order()).toEqual(["a", "b", "c"]);
    expect(f.server.draft.revision).toBe(5);
    expect(f.controller.snapshot().draftUndo).toBeNull();
    expect(await f.controller.undoDraftMove()).toBe(false);
  });

  test("restores a moved node to its original branch without replacing either branch", async () => {
    const f = fixture([{ id: "parallel", kind: "parallel", branches: [
      { id: "left", kind: "sequence", children: [tool("a"), tool("b")] },
      { id: "right", kind: "sequence", children: [tool("c")] },
    ] }]);
    const original = structuredClone(f.server.draft.definition.body);
    await f.controller.openRoute("one");
    await f.controller.mutateDraft(move("b", 0, "right"));
    expect(await f.controller.undoDraftMove()).toBe(true);
    expect(f.server.draft.definition.body).toEqual(original);
    expect(f.client.mutateAutomationDraft).toHaveBeenLastCalledWith("one", 2, move("b", 1, "left"), "dev");
  });

  test("retains move history across list/reentry, but clears it after a different saved edit", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    await f.controller.mutateDraft(move("a", 2));
    await f.controller.openRoute("");
    expect(f.controller.snapshot().draftUndo).toBeNull();
    await f.controller.openRoute("one");
    expect(f.controller.snapshot().draftUndo.count).toBe(1);
    await f.controller.saveDefinition({ title: "Renamed workflow" });
    expect(f.controller.snapshot().draftUndo).toBeNull();
    expect(await f.controller.undoDraftMove()).toBe(false);
    expect(f.order()).toEqual(["b", "a", "c"]);
  });

  test("never overwrites another editor's revision and invalidates history when refreshed", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    await f.controller.mutateDraft(move("a", 2));
    await f.write("one", 2, { kind: "update_definition", patch: { title: "External edit" } }, "dev");
    expect(await f.controller.undoDraftMove()).toBe(false);
    expect(f.server.draft.definition.title).toBe("External edit");
    expect(f.order()).toEqual(["b", "a", "c"]);
    expect(f.controller.snapshot().error).toContain("automation_revision_conflict");
    await f.controller.refresh();
    expect(f.controller.snapshot().draftUndo).toBeNull();
    const calls = f.client.mutateAutomationDraft.mock.calls.length;
    expect(await f.controller.undoDraftMove()).toBe(false);
    expect(f.client.mutateAutomationDraft).toHaveBeenCalledTimes(calls);
  });

  test("bounds session history to twenty moves and preserves the next inverse after each undo", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    for (let index = 0; index < 24; index += 1)
      await f.controller.mutateDraft(move("a", index % 2 === 0 ? 2 : 0));
    expect(f.controller.snapshot().draftUndo.count).toBe(20);
    for (let index = 0; index < 20; index += 1) expect(await f.controller.undoDraftMove()).toBe(true);
    expect(f.controller.snapshot().draftUndo).toBeNull();
    expect(f.server.draft.revision).toBe(45);
  });

  test.each(["move", "undo"])("does not dispatch a second Undo while a %s mutation is pending", async (pending) => {
    const f = fixture();
    await f.controller.openRoute("one");
    await f.controller.mutateDraft(move("a", 2));
    const held = gate();
    f.client.mutateAutomationDraft.mockImplementationOnce(async (...args) => {
      await held.promise;
      return f.write(...args);
    });
    const saving = pending === "undo" ? f.controller.undoDraftMove() : f.controller.mutateDraft(move("c", 0));
    expect(await f.controller.undoDraftMove()).toBe(false);
    expect(f.client.mutateAutomationDraft).toHaveBeenCalledTimes(2);
    held.release();
    expect(await saving).toBe(true);
    expect(f.controller.snapshot().draftUndo?.count ?? 0).toBe(pending === "undo" ? 0 : 2);
  });

  test("restoration requires explicit confirmation and sends only the captured published revision", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    expect(await f.controller.restorePublishedDraft(() => false)).toBe(false);
    expect(f.client.mutateAutomationDraft).not.toHaveBeenCalled();
    f.client.mutateAutomationDraft.mockResolvedValueOnce({ draft: { ...f.server.draft, revision: 2,
      definition: { ...f.published, revision: 2 } } });
    const confirm = vi.fn(() => true);
    expect(await f.controller.restorePublishedDraft(confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith({ title: "Workflow", publishedRevision: 1 });
    expect(f.client.mutateAutomationDraft).toHaveBeenCalledExactlyOnceWith("one", 1,
      { kind: "restore_published", publishedRevision: 1 }, "dev");
    expect(f.controller.snapshot().selectedNodeId).toBe("");
  });

  test.each(["navigation", "environment", "draft revision"])("rejects stale restore confirmation after %s changes", async (changed) => {
    const f = fixture();
    await f.controller.openRoute("one");
    const held = gate();
    const restoring = f.controller.restorePublishedDraft(async () => { await held.promise; return true; });
    if (changed === "navigation") { await f.controller.openRoute(""); await f.controller.openRoute("one"); }
    if (changed === "environment") f.setEnvironment("prod");
    if (changed === "draft revision") await f.controller.saveDefinition({ title: "Keep newer edit" });
    const calls = f.client.mutateAutomationDraft.mock.calls.length;
    held.release();
    expect(await restoring).toBe(false);
    expect(f.client.mutateAutomationDraft).toHaveBeenCalledTimes(calls);
    if (changed === "draft revision") expect(f.server.draft.definition.title).toBe("Keep newer edit");
  });

  test("recovery controls are explicit and unsaved form edits block both commands", async () => {
    const f = fixture();
    await f.controller.openRoute("one");
    const html = renderAutomationDraftRecovery(f.controller.snapshot());
    expect(html).toContain('data-action="undo-draft-move"');
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    const root = document.createElement("section");
    root.innerHTML = html;
    expect(root.querySelector('[data-action="undo-draft-move"]')?.disabled).toBe(true);
    expect(html).toContain('data-action="restore-published-draft"');
    const commands = createAutomationDraftRecoveryCommands({ actions: f.controller,
      requireSavedGraph: () => false, confirmDiscard: vi.fn(() => true), onRestored: vi.fn() });
    await commands["undo-draft-move"]();
    await commands["restore-published-draft"]();
    expect(f.client.mutateAutomationDraft).not.toHaveBeenCalled();
  });
});
