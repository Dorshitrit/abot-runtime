import { expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationConfirmations, createAutomationDestructiveCommands } from "../../web-ui/app/components/automations/confirmation-actions.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationWorkspaceNavigation } from "../../web-ui/app/components/automations/workspace-navigation.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationArchiveCommands } from "../../web-ui/app/components/automations/archive-actions.js";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(confirm: () => boolean | Promise<boolean>) {
  let environment = "prod", navigationRevision = 0, editRevision = 0;
  const current = { selectedAutomationId: "one", selectedRunId: "", selectedNodeId: "step-one",
    draft: { revision: 3 }, publishedDefinition: null as { revision: number } | null,
    automations: [{ id: "one", status: "draft", publishedRevision: 0 }],
    run: { id: "run-one", status: "failed" }, mutation: "" };
  const actions = { snapshot: () => current,
    captureActionScope: () => { const selected = environment, revision = navigationRevision;
      return () => selected === environment && revision === navigationRevision; },
    mutateDraft: vi.fn(async () => true), selectNode: vi.fn(), deleteDraft: vi.fn(async () => true),
    rerun: vi.fn(async () => true), archive: vi.fn(async () => true) };
  const scope = { actions, getCurrent: () => current, getEditRevision: () => editRevision };
  const confirmations = createAutomationConfirmations({ ...scope, confirm });
  const commands = createAutomationDestructiveCommands({ ...scope, confirmations,
    requireSavedGraph: () => true, onDraftDeleted: vi.fn() });
  return { current, actions, scope, confirmations, commands,
    changeEnvironment: () => { environment = "dev"; },
    navigate: () => { navigationRevision += 1; }, edit: () => { editRevision += 1; } };
}

test.each([true, false])("step removal waits for its explicit async approval: %s", async (approved) => {
  const answer = deferred<boolean>(), f = fixture(() => answer.promise);
  const pending = f.commands["remove-node"]();
  expect(f.actions.mutateDraft).not.toHaveBeenCalled();
  answer.resolve(approved);
  expect(await pending).toBe(approved);
  if (approved) expect(f.actions.mutateDraft).toHaveBeenCalledExactlyOnceWith({ kind: "remove_node", nodeId: "step-one" });
  else expect(f.actions.mutateDraft).not.toHaveBeenCalled();
});

test.each(["environment", "navigation", "draft", "node", "edits", "published", "run", "mutation"])(
  "an approval cannot authorize a changed %s scope", async (change) => {
    const answer = deferred<boolean>(), f = fixture(() => answer.promise);
    const pending = f.commands["delete-draft"]();
    if (change === "environment") f.changeEnvironment();
    if (change === "navigation") f.navigate();
    if (change === "draft") f.current.draft.revision += 1;
    if (change === "node") f.current.selectedNodeId = "other-step";
    if (change === "edits") f.edit();
    if (change === "published") f.current.publishedDefinition = { revision: 3 };
    if (change === "run") f.current.selectedRunId = "another-run";
    if (change === "mutation") f.current.mutation = "Another operation";
    answer.resolve(true);
    expect(await pending).toBe(false);
    expect(f.actions.deleteDraft).not.toHaveBeenCalled();
  });

test("a newer declined action does not leave an older pending approval effective", async () => {
  const answer = deferred<boolean>();
  const confirm = vi.fn<() => boolean | Promise<boolean>>()
    .mockImplementationOnce(() => answer.promise).mockReturnValueOnce(false);
  const f = fixture(confirm);
  const older = f.commands["remove-node"]();
  expect(await f.commands["delete-draft"]()).toBe(false);
  answer.resolve(true);
  expect(await older).toBe(false);
  expect(f.actions.mutateDraft).not.toHaveBeenCalled();
  expect(f.actions.deleteDraft).not.toHaveBeenCalled();
});

test("rejected confirmation fails closed without invoking the operation", async () => {
  const f = fixture(() => Promise.reject(new Error("Dialog unavailable")));
  expect(await f.commands["delete-draft"]()).toBe(false);
  expect(f.actions.deleteDraft).not.toHaveBeenCalled();
});

test("archive and rerun bind approvals to the selected published automation and run", async () => {
  const archiveAnswer = deferred<boolean>(), f = fixture(() => archiveAnswer.promise);
  f.current.automations[0]!.publishedRevision = 3;
  f.current.automations[0]!.status = "paused";
  const onFilterChange = vi.fn();
  const archive = createAutomationArchiveCommands({ actions: f.actions, getCurrent: () => f.current,
    requireSavedGraph: () => true, confirmations: f.confirmations, onFilterChange });
  const pendingArchive = archive.archive();
  expect(f.actions.archive).not.toHaveBeenCalled();
  f.current.automations[0]!.status = "archived";
  archiveAnswer.resolve(true);
  await pendingArchive;
  expect(f.actions.archive).not.toHaveBeenCalled();
  expect(onFilterChange).not.toHaveBeenCalled();
  const rerunAnswer = deferred<boolean>(), g = fixture(() => rerunAnswer.promise);
  const pendingRerun = g.commands.rerun();
  g.current.run.id = "different-run";
  rerunAnswer.resolve(true);
  expect(await pendingRerun).toBe(false);
  expect(g.actions.rerun).not.toHaveBeenCalled();
});

test("workspace navigation awaits discard and rejects a superseded view", async () => {
  const answer = deferred<boolean>(), f = fixture(() => true);
  const operation = vi.fn(() => true);
  const navigation = createAutomationWorkspaceNavigation({ ...f.scope, prepareLeave: () => answer.promise });
  const pending = navigation.leave(operation);
  expect(operation).not.toHaveBeenCalled();
  f.navigate();
  answer.resolve(true);
  expect(await pending).toBe(false);
  expect(operation).not.toHaveBeenCalled();
});

test("clean workspace navigation retains immediate node-selection semantics", () => {
  const f = fixture(() => true), operation = vi.fn(() => true);
  const navigation = createAutomationWorkspaceNavigation({ ...f.scope, prepareLeave: () => true });
  expect(navigation.leave(operation)).toBe(true);
  expect(operation).toHaveBeenCalledOnce();
});


test.each(["draft", "published", "navigation", "environment"])(
  "controller approval scope rejects a changed %s source", async (change) => {
    let draftRevision = 3, publishedRevision = 2, environment = "prod";
    const controller = createAutomationsController({ getEnvironmentId: () => environment, render: vi.fn(),
      client: { supportsAutomations: () => true,
        listAutomations: async () => ({ automations: [{ id: "one", status: "paused" }] }),
        getAutomationCatalog: async () => ({ operations: [], models: [], savedAgents: [] }),
        listAutomationRuns: async () => ({ runs: [] }),
        getAutomationDraft: async (automationId: string) => ({
          draft: { automationId, revision: draftRevision, definition: { automationId, title: "One",
            body: { kind: "sequence", id: "root", children: [] } } },
          publishedDefinition: { automationId, revision: publishedRevision },
        }),
      } });
    await controller.openRoute("one");
    const isCurrent = controller.captureActionScope();
    await controller.refresh();
    expect(isCurrent()).toBe(true);
    if (change === "draft") draftRevision += 1;
    if (change === "published") publishedRevision += 1;
    if (change === "navigation") await controller.openRoute("two");
    if (change === "environment") environment = "dev";
    if (change === "draft" || change === "published") await controller.refresh();
    expect(isCurrent()).toBe(false);
  });
