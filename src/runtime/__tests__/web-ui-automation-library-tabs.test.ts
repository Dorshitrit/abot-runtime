import { describe, expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsWorkspace } from "../../web-ui/app/components/automations/workspace.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { automationLibraryTabForKey } from "../../web-ui/app/components/automations/library-tabs.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationEditor } from "../../web-ui/app/components/automations/editor.js";

function fixture(selectedAutomationId = "") {
  const document = {} as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const root = document.createElement("section");
  document.body.append(root);
  const definition = { schemaVersion: 1, automationId: "one", revision: 1,
    title: "Review", objective: "", inputs: {}, trigger: { kind: "manual" }, limits: {},
    body: { kind: "sequence", id: "sequence", children: [] } };
  const snapshot = { automations: [{ id: "one", title: "Review", status: "draft" }],
    selectedAutomationId, selectedRunId: "", selectedNodeId: "", runs: [],
    draft: selectedAutomationId ? { revision: 1, definition } : null,
    catalog: { operations: [], grantableOperations: [], models: [], savedAgents: [] },
    templateCatalog: { templates: [{ id: "starter", title: "Starter", category: "Local",
      description: "A reusable draft", stepCount: 2, toolNames: [] }] },
    error: "", feedback: "", loading: false, mutation: "" };
  return { document, root, snapshot };
}

describe("ABot Studio library tabs", () => {
  test("moves available templates into their own Memory-style tab", () => {
    const { document, root, snapshot } = fixture();
    createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot } });
    const studio = root.querySelector('[data-automation-library-panel="studio"]')!;
    const templates = root.querySelector('[data-automation-library-panel="templates"]')!;
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();
    expect(studio.hidden).toBe(false);
    expect(templates.hidden).toBe(true);
    expect(studio.querySelector('[data-template-id="starter"]')).toBeNull();
    expect(templates.querySelector('[data-template-id="starter"]')).not.toBeNull();
    root.querySelector('[data-automation-library-tab="templates"]')!.dispatch("click");
    expect(studio.hidden).toBe(true);
    expect(templates.hidden).toBe(false);
    expect(root.querySelector('[data-automation-library-tab="templates"]')!.attributes.get("aria-selected")).toBe("true");
    root.querySelector('[data-automation-library-tab="studio"]')!.dispatch("click");
    expect(studio.hidden).toBe(false);
    expect(templates.hidden).toBe(true);
  });

  test("uses the existing template action and keeps draft navigation in Studio", async () => {
    const { document, root, snapshot } = fixture();
    const createTemplate = vi.fn(async () => true);
    const workspace = createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot, createTemplate } });
    root.querySelector('[data-automation-library-tab="templates"]')!.dispatch("click");
    root.querySelector('[data-template-id="starter"]')!.dispatch("click");
    expect(createTemplate).toHaveBeenCalledExactlyOnceWith("starter");
    workspace.render({ ...snapshot, selectedAutomationId: "one",
      draft: { revision: 1, definition: { schemaVersion: 1, automationId: "one", revision: 1,
        title: "Review", objective: "", inputs: {}, trigger: { kind: "manual" }, limits: {},
        body: { kind: "sequence", id: "sequence", children: [] } } } });
    expect(root.querySelector('[data-automation-library-tab="studio"]')!.attributes.get("aria-selected")).toBe("true");
    expect(root.querySelector('[data-automation-library-panel="studio"]')!.hidden).toBe(false);
  });

  test("asks before leaving an unsaved editor and keeps its values on cancel", async () => {
    const { document, root, snapshot } = fixture("one");
    const confirmDiscard = vi.fn(() => false);
    const openRoute = vi.fn(async () => true);
    createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot, openRoute }, confirmDiscard });
    const name = root.querySelector('[data-automation-definition-form]')!.querySelector('[name="title"]')!;
    name.value = "Unsaved title";
    name.dispatch("input");
    root.querySelector('[data-automation-library-tab="templates"]')!.dispatch("click");
    await Promise.resolve();
    expect(confirmDiscard).toHaveBeenCalledOnce();
    expect(openRoute).not.toHaveBeenCalled();
    expect(root.querySelector('[data-automation-library-panel="studio"]')!.hidden).toBe(false);
    expect(name.value).toBe("Unsaved title");
  });

  test.each(["approve", "edit"])("async discard handles %s without using a pending Promise as approval", async (outcome) => {
    const { document, root, snapshot } = fixture("one");
    let approve!: (approved: boolean) => void;
    const openRoute = vi.fn(async () => true);
    const workspace = createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot, openRoute },
      confirmDiscard: () => new Promise<boolean>((resolve) => { approve = resolve; }) });
    const name = root.querySelector('[data-automation-definition-form]')!.querySelector('[name="title"]')!;
    name.value = "Unsaved title";
    name.dispatch("input");
    root.querySelector('[data-automation-library-tab="templates"]')!.dispatch("click");
    expect(openRoute).not.toHaveBeenCalled();
    expect(workspace.isDirty()).toBe(true);
    if (outcome === "edit") { name.value = "Newer title"; name.dispatch("input"); }
    approve(true);
    if (outcome === "approve") await vi.waitFor(() => expect(openRoute).toHaveBeenCalledExactlyOnceWith("", ""));
    else {
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(openRoute).not.toHaveBeenCalled();
      expect(workspace.isDirty()).toBe(true);
    }
  });

  test("a workspace discard remains uncommitted while another navigation guard is pending", async () => {
    const { document, root, snapshot } = fixture("one");
    const workspace = createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot }, confirmDiscard: () => true });
    const name = root.querySelector('[data-automation-definition-form]')!.querySelector('[name="title"]')!;
    name.value = "Unsaved title"; name.dispatch("input");
    const commit = await workspace.prepareLeave();
    expect(typeof commit).toBe("function");
    expect(workspace.isDirty()).toBe(true);
    expect(commit.canCommit()).toBe(true);
    name.value = "Newer title"; name.dispatch("input");
    expect(commit.canCommit()).toBe(false);
    expect(commit()).toBe(false);
    expect(workspace.isDirty()).toBe(true);
    const nextCommit = await workspace.prepareLeave();
    expect(nextCommit()).toBe(true);
    expect(workspace.isDirty()).toBe(false);
  });

  test("keeps the prior view stable during selected draft loading and shows real failures", () => {
    const { document, root, snapshot } = fixture();
    const workspace = createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot } });
    const existingList = root.querySelector('[data-automation-library-panel="studio"]');
    workspace.render({ ...snapshot, selectedAutomationId: "one", draft: null, loading: true });
    expect(root.querySelector('[data-automation-library-panel="studio"]')).toBe(existingList);
    expect(root.querySelector(".automation-workspace-content")!.inert).toBe(true);
    expect(root.attributes.get("aria-busy")).toBe("true");
    workspace.render({ ...snapshot, selectedAutomationId: "one", draft: null,
      loading: false, error: "Draft could not load" });
    expect(root.querySelector('[data-automation-library-panel="studio"]')).not.toBe(existingList);
    expect(root.textContent).toContain("Draft could not load");
    expect(root.attributes.get("aria-busy")).toBe("false");
  });

  test("supports the same Home, End, and arrow tab navigation as Memory", () => {
    expect(automationLibraryTabForKey("Home", 1)).toBe("studio");
    expect(automationLibraryTabForKey("End", 0)).toBe("templates");
    expect(automationLibraryTabForKey("ArrowRight", 0)).toBe("templates");
    expect(automationLibraryTabForKey("ArrowLeft", 0)).toBe("templates");
  });

  test("groups folder-source switches apart from path and processing controls", () => {
    const { snapshot } = fixture("one");
    const draft = snapshot.draft!;
    const markup = renderAutomationEditor({ ...snapshot, draft: { ...draft,
      definition: { ...draft.definition, source: { location: { path: "/inbox" },
        mode: "per_file", recursive: true, includeExisting: false } },
    } });
    const switches = markup.match(/<div class="automation-source-options">[\s\S]*?<\/div>/)?.[0];
    expect(switches?.match(/type="checkbox"/g)).toHaveLength(3);
    expect(switches).toContain('name="sourceEnabled"');
    expect(switches).toContain('name="sourceRecursive"');
    expect(switches).toContain('name="includeExisting"');
    expect(markup).toContain('class="automation-source-fields"');
  });
});
