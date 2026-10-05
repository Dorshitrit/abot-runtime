import { describe, expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
import { createAutomationRequests } from "../../web-ui/app/services/runtime-web-client/automations.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsWorkspace } from "../../web-ui/app/components/automations/workspace.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationList } from "../../web-ui/app/components/automations/list.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationEditor } from "../../web-ui/app/components/automations/editor.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationRun } from "../../web-ui/app/components/automations/run.js";

const definition = { schemaVersion: 1, automationId: "one", revision: 3,
  title: "Review", objective: "", inputs: {}, trigger: { kind: "manual" }, limits: {},
  body: { kind: "sequence", id: "sequence", children: [] } };
const item = (status: string, id = "one") => ({ id, title: id, status,
  draftRevision: 3, publishedRevision: 2, latestRunId: "run-one" });

describe("ABot Studio archive controls", () => {
  test("client sends archive and restore with revision and encoded identity", async () => {
    const requestApi = vi.fn(async () => ({ ok: true }));
    const client = createAutomationRequests({ requestApi,
      getEnvironmentId: () => "dev", getConfig: () => ({ backend: "runtime" }) });
    await client.archiveAutomation("one/two", 3, "dev");
    await client.restoreAutomation("one/two", 3, "dev");
    expect(requestApi.mock.calls).toEqual([
      ["/automations/one%2Ftwo/archive?environment=dev", { method: "POST",
        body: JSON.stringify({ expectedRevision: 3 }) }],
      ["/automations/one%2Ftwo/restore?environment=dev", { method: "POST",
        body: JSON.stringify({ expectedRevision: 3 }) }],
    ]);
  });

  test("controller refreshes archive state while preserving selected reports", async () => {
    let status = "active";
    const archiveAutomation = vi.fn(async () => { status = "archived"; return { ok: true }; });
    const restoreAutomation = vi.fn(async () => { status = "paused"; return { ok: true }; });
    const client = {
      supportsAutomations: () => true,
      listAutomations: async () => ({ automations: [item(status)] }),
      getAutomationDraft: async () => ({ draft: { automationId: "one", revision: 3,
        definition, ...(status === "archived" ? { archivedAt: "2026-09-29T00:00:00.000Z" } : {}) },
        publishedDefinition: definition }),
      getAutomationCatalog: async () => ({ operations: [] }),
      listAutomationRuns: async () => ({ runs: [{ id: "run-one", status: "succeeded" }] }),
      archiveAutomation, restoreAutomation,
    };
    const controller = createAutomationsController({ client, getEnvironmentId: () => "dev",
      render: () => {} });
    await controller.openRoute("one");
    expect(await controller.archive()).toBe(true);
    expect(archiveAutomation).toHaveBeenCalledExactlyOnceWith("one", 3, "dev");
    expect(controller.snapshot().automations[0].status).toBe("archived");
    expect(controller.snapshot().runs[0].id).toBe("run-one");
    expect(await controller.restore()).toBe(true);
    expect(restoreAutomation).toHaveBeenCalledExactlyOnceWith("one", 3, "dev");
    expect(controller.snapshot().automations[0].status).toBe("paused");
    expect(controller.snapshot().runs[0].id).toBe("run-one");
  });

  test("Current excludes archived automations and Archived keeps them reachable", () => {
    const snapshot = { automations: [item("paused", "current"), item("archived", "old")],
      loading: false, error: "" };
    const current = renderAutomationList(snapshot);
    const archived = renderAutomationList(snapshot, { archived: true });
    expect(current).toContain('data-select-automation="current"');
    expect(current).not.toContain('data-select-automation="old"');
    expect(archived).toContain('data-select-automation="old"');
    expect(archived).not.toContain('data-select-automation="current"');
    expect(archived).toContain('data-state="archived"');
  });

  test("archived editor and run remain readable without edit or rerun controls", () => {
    const snapshot = { automations: [item("archived")], selectedAutomationId: "one",
      selectedNodeId: "", selectedRunId: "", runs: [{ id: "run-one", status: "succeeded" }],
      draft: { revision: 3, definition, archivedAt: "2026-09-29T00:00:00.000Z" },
      publishedDefinition: definition, catalog: { operations: [], models: [], savedAgents: [] },
      validation: null, error: "", feedback: "", run: null };
    const editor = renderAutomationEditor(snapshot);
    expect(editor).toContain('data-action="restore"');
    expect(editor).toContain('data-automation-definition-form inert');
    expect(editor).not.toContain('data-action="save-draft"');
    expect(editor).not.toContain('data-action="run"');
    expect(editor).not.toContain('data-action="publish"');
    expect(editor).not.toContain('data-palette-agent="new"');
    const run = renderAutomationRun({ ...snapshot, selectedRunId: "run-one",
      run: { id: "run-one", status: "succeeded", definition, definitionRevision: 2,
        nodes: [], report: null } });
    expect(run).toContain('data-action="editor"');
    expect(run).not.toContain('data-action="rerun"');
  });

  test("workspace filter switches between current and archived rows", () => {
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    document.body.append(root);
    const snapshot = { automations: [item("paused", "current"), item("archived", "old")],
      selectedAutomationId: "", selectedNodeId: "", selectedRunId: "", runs: [],
      draft: null, catalog: null, error: "", feedback: "", loading: false, mutation: "" };
    createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot } });
    expect(root.querySelector('[data-select-automation="old"]')).toBeNull();
    root.querySelector('[data-automation-list-filter="archived"]')!.dispatch("click");
    expect(root.querySelector('[data-select-automation="current"]')).toBeNull();
    expect(root.querySelector('[data-select-automation="old"]')).not.toBeNull();
  });

  test("editor archive button confirms the selected published automation", async () => {
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    document.body.append(root);
    const snapshot = { automations: [item("paused")], selectedAutomationId: "one",
      selectedNodeId: "", selectedRunId: "", runs: [], draft: { revision: 3, definition },
      publishedDefinition: definition, catalog: { operations: [], models: [], savedAgents: [] },
      validation: null, error: "", feedback: "", loading: false, mutation: "" };
    const archive = vi.fn(async () => true);
    const confirmDiscard = vi.fn(() => true);
    createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot, archive }, confirmDiscard });
    root.querySelector('[data-action="archive"]')!.dispatch("click");
    await vi.waitFor(() => expect(archive).toHaveBeenCalledOnce());
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });
});
