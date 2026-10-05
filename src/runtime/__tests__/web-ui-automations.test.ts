import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationTimeline } from "../../web-ui/app/components/automations/timeline.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationRun } from "../../web-ui/app/components/automations/run.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationEditor, renderAutomationToolResults } from "../../web-ui/app/components/automations/editor.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationNodeInspector } from "../../web-ui/app/components/automations/node-inspector.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsWorkspace, paletteNode } from "../../web-ui/app/components/automations/workspace.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { selectedAutomationOperations } from "../../web-ui/app/components/automations/permission-selection.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsController } from "../../web-ui/app/controllers/automations-controller.js";
import { createAutomationRequests } from "../../web-ui/app/services/runtime-web-client/automations.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { automationRerunConfirmation } from "../../web-ui/app/components/automations/rerun-confirmation.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationList } from "../../web-ui/app/components/automations/list.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { automationAuthoringStarter, openAutomationAuthoringChat } from "../../web-ui/app/components/automations/authoring-entry.js";

const agent = (id: string, title: string) => ({
  kind: "agent", id, title, modelProfileId: "local", agentMode: "fast", onFailure: "stop",
  prompt: "Check this input", roleInstructions: "", inputs: {}, tools: [], result: { kind: "text" },
});
const definition = (revision: number, title = "Draft title") => ({
  schemaVersion: 1, automationId: "automation-one", revision, title, objective: "", inputs: {},
  trigger: { kind: "manual" }, limits: {},
  body: { kind: "sequence", id: "root-sequence", children: [agent("first", "First step"), agent("second", "Second step")] },
});

describe("ABot Studio graph and run projection", () => {
  test("groups grantable tools and reveals operations only for the selected tool", () => {
    const search = { toolName: "web_search", operationId: "search_one", contractVersion: 1,
      label: "Search one public query", pluginName: "web", toolDescription: "Search public sources",
      permissionMode: "full_access", input: { properties: { query: { type: "string" } }, required: ["query"] } };
    const fetch = { toolName: "web_fetch", operationId: "fetch_one", contractVersion: 1,
      label: "Fetch one URL", pluginName: "web", toolDescription: "Fetch public pages",
      permissionMode: "full_plus", input: { properties: { url: { type: "string" } }, required: ["url"] } };
    const catalog = { grantableOperations: [search, fetch], operations: [search] };
    const closed = renderAutomationToolResults(catalog);
    expect(closed).toContain('<details class="automation-tool-group"><summary><strong>Web</strong><small>2 tools · 2 operations</small>');
    expect(closed).toContain("Web Search");
    expect(closed).toContain("Web Fetch");
    expect(closed).not.toContain("Search one public query");
    expect(closed).not.toContain("Search public sources");
    const opened = renderAutomationToolResults(catalog, { selectedToolName: "web_fetch" });
    expect(opened).toContain('<details class="automation-tool-group" open>');
    expect(opened).toContain("Fetch one URL");
    expect(opened).toContain("FULL+ · permission needed");
    expect(opened).not.toContain("Search one public query");
    const filtered = renderAutomationToolResults(catalog, { query: "fetch" });
    expect(filtered).toContain('<details class="automation-tool-group" open>');
    expect(filtered).toContain("Web Fetch");
    expect(filtered).not.toContain("Web Search");

    const draftTool = paletteNode({ kind: "tool", id: "web_fetch" }, catalog);
    expect(draftTool).toMatchObject({ title: "Web Fetch", controls: {},
      operation: { toolName: "web_fetch", operationId: "", contractVersion: 1 } });
    const inspector = renderAutomationNodeInspector({ ...draftTool, id: "tool-1" }, catalog);
    expect(inspector).toContain("Select an operation");
    expect(inspector).not.toContain('data-action="permission"');
    const configured = renderAutomationNodeInspector({ ...draftTool, id: "tool-1",
      operation: { toolName: "web_fetch", operationId: "fetch_one", contractVersion: 1 } }, catalog);
    expect(configured).toContain("FULL+ permission needed before publishing");
    expect(configured).not.toContain('data-action="permission"');
    expect(configured).toContain('value="url"');
  });

  test("shows backend readiness reasons without offering an unavailable run", () => {
    const markup = renderAutomationEditor({
      automations: [{ id: "automation-one", status: "paused", publishedRevision: 2,
        canRun: false, canActivate: false, runUnavailableReason: "Source adapter unavailable" }],
      selectedAutomationId: "automation-one", selectedNodeId: "", runs: [],
      draft: { revision: 3, definition: definition(3) }, catalog: { operations: [], models: [], savedAgents: [] },
      grant: null, validation: null, error: "", feedback: "",
    });
    expect(markup).toContain('data-action="run" disabled');
    expect(markup).toContain('data-action="toggle-active" disabled');
    expect(markup).toContain("Source adapter unavailable");
    expect(markup).not.toContain('data-action="delete-draft"');
  });

  test("offers deletion only for an unpublished draft", () => {
    const markup = renderAutomationEditor({
      automations: [{ id: "automation-one", status: "draft", publishedRevision: null }],
      selectedAutomationId: "automation-one", selectedNodeId: "", runs: [],
      draft: { revision: 1, definition: definition(1) },
      publishedDefinition: null, catalog: { operations: [], models: [], savedAgents: [] },
      grant: null, validation: null, error: "", feedback: "",
    });
    expect(markup).toContain('data-action="delete-draft"');
    expect(markup).toContain("Delete draft");
  });

  test("uses one serial connector per segment and one split/join for a parallel group", () => {
    const empty = renderAutomationTimeline({ ...definition(1), body: {
      kind: "sequence", id: "root-sequence", children: [],
    } }, { editable: true });
    expect(empty).toContain("Add first step");
    expect(empty).toContain("Choose from Tools or Agents, or drag here");
    expect(empty).toContain('data-insert-parent="root-sequence" data-insert-index="0"');
    const serial = renderAutomationTimeline(definition(1), { editable: true });
    expect(serial.match(/class="automation-connector/g)).toHaveLength(3);
    const running = renderAutomationTimeline(definition(1), {
      run: { nodes: [{ nodeId: "second", status: "running" }] },
    });
    expect(running.match(/data-active="true"/g)).toHaveLength(1);
    const graph = { ...definition(1), body: {
      kind: "sequence", id: "root-sequence", children: [{
        kind: "parallel", id: "parallel-one", branches: [
          { kind: "sequence", id: "branch-one", children: [agent("first", "First step")] },
          { kind: "sequence", id: "branch-two", children: [agent("second", "Second step")] },
        ],
      }],
    } };
    const parallel = renderAutomationTimeline(graph, { editable: true });
    expect(parallel.match(/class="automation-fork"/g)).toHaveLength(1);
    expect(parallel.match(/class="automation-join"/g)).toHaveLength(1);
    expect(parallel.match(/class="automation-connector/g)).toHaveLength(6);
  });

  test("renders a saved run from its frozen definition and does not invent missing usage", () => {
    const archived = definition(2, "Published title");
    const markup = renderAutomationRun({
      automations: [{ id: "automation-one", title: "Current draft title" }],
      selectedAutomationId: "automation-one", selectedRunId: "run-one", selectedNodeId: "",
      runs: [{ id: "run-one", status: "completed", startedAt: "2026-09-29T00:00:00Z" }],
      run: {
        id: "run-one", automationId: "automation-one", status: "completed",
        target: { kind: "automation", automationId: "automation-one", definitionRevision: 2 },
        definition: archived, nodes: [{ nodeId: "first", status: "succeeded" }],
        report: { outcome: "completed", modelCalls: null, toolCalls: 1, nodeResults: [],
          inputVersions: [], uncertainEffects: [], artifacts: [] },
      },
    });
    expect(markup).toContain("Published title");
    expect(markup).toContain("Revision 2");
    expect(markup).not.toContain("Current draft title");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Tool calls</span><strong>1");
    expect(markup).not.toContain("data-action=\"save-step\"");
    const locked = renderAutomationRun({
      automations: [], selectedAutomationId: "automation-one", selectedRunId: "run-one",
      selectedNodeId: "", runs: [],
      run: { id: "run-one", automationId: "automation-one", status: "completed",
        definitionRevision: 2, definition: archived, nodes: [], report: null },
    }, { locked: true });
    expect(locked).toContain("data-action=\"return-studio\"");
    expect(locked).not.toContain("data-action=\"editor\"");
    expect(locked).not.toContain("data-action=\"rerun\"");
    expect(locked).not.toContain("role=\"tablist\"");
  });

});

describe("ABot Studio persistence boundary", () => {
  test("an operation requiring interactive approval asks for FULL+ in an automation", () => {
    const operation = { toolName: "reader", operationId: "sensitive_read", contractVersion: 1,
      permissionMode: "full_access", approval: "always", label: "Sensitive read" };
    const workflow = { ...definition(1), body: { kind: "sequence", id: "root-sequence", children: [{
      kind: "tool", id: "sensitive", title: "Sensitive read", onFailure: "stop",
      operation: { toolName: operation.toolName, operationId: operation.operationId, contractVersion: 1 },
      controls: {},
    }] } };
    expect(selectedAutomationOperations(workflow, { grantableOperations: [operation], operations: [] }))
      .toMatchObject({ mode: "full_plus", operations: [
        { toolName: "reader", operationId: "sensitive_read" },
      ] });
  });

  test("shows selected tool permission as a read-only indicator after Resource limits", () => {
    const read = { toolName: "reader", operationId: "read", contractVersion: 1,
      permissionMode: "full_access", label: "Read" };
    const write = { toolName: "writer", operationId: "write", contractVersion: 1,
      permissionMode: "full_plus", label: "Write" };
    const tool = (item: typeof read) => ({ kind: "tool", id: item.toolName, title: item.label,
      onFailure: "stop", operation: { toolName: item.toolName,
        operationId: item.operationId, contractVersion: 1 }, controls: {} });
    const empty = definition(1);
    const snapshot = { automations: [], selectedAutomationId: "automation-one", selectedNodeId: "",
      runs: [], draft: { revision: 1, definition: empty },
      catalog: { grantableOperations: [read, write], operations: [], models: [], savedAgents: [] },
      grant: null, validation: null, error: "", feedback: "" };
    const indicator = (markup: string) => markup.match(/<details class="automation-permission"[\s\S]*?<\/details>/)?.[0];
    expect(indicator(renderAutomationEditor(snapshot))).toContain("No tool operations selected.");
    const fullMarkup = renderAutomationEditor({ ...snapshot, draft: { revision: 1,
      definition: { ...empty, body: { ...empty.body, children: [tool(read)] } },
    } });
    expect(fullMarkup.indexOf("Resource limits")).toBeLessThan(fullMarkup.indexOf('class="automation-permission"'));
    expect(fullMarkup.indexOf('class="automation-permission"')).toBeLessThan(fullMarkup.indexOf("</form>"));
    expect(indicator(fullMarkup)).toContain("Full required · 1 selected operation");
    expect(indicator(fullMarkup)).not.toContain('class="automation-permission" open');
    expect(indicator(fullMarkup)).toContain("Reader · Read");
    const plusMarkup = renderAutomationEditor({ ...snapshot, draft: { revision: 1,
      definition: { ...empty, body: { ...empty.body, children: [tool(read), tool(write)] } },
    } });
    expect(indicator(plusMarkup)).toContain("FULL+ required · 2 selected operations");
    expect(indicator(plusMarkup)).toContain("Writer · Write");
    expect(plusMarkup.indexOf('data-action="toggle-details"')).toBeLessThan(plusMarkup.indexOf('id="automation-editor-details"'));
    expect(plusMarkup).not.toContain('data-action="permission"');
  });

  test("confirms only deduplicated selected operations and explicit FULL+ before publishing", async () => {
    const read = { toolName: "reader", operationId: "read", contractVersion: 1,
      permissionMode: "full_access", label: "Read", input: { properties: {}, required: [] } };
    const write = { toolName: "writer", operationId: "write", contractVersion: 1,
      permissionMode: "full_plus", label: "Write", input: { properties: {}, required: [] } };
    const unused = { toolName: "unused", operationId: "other", contractVersion: 1,
      permissionMode: "full_access", label: "Unused", input: { properties: {}, required: [] } };
    const toolNode = (id: string, operation: typeof read) => ({
      kind: "tool", id, title: id, onFailure: "stop", operation: {
        toolName: operation.toolName, operationId: operation.operationId,
        contractVersion: operation.contractVersion,
      }, controls: {},
    });
    const workflow = { ...definition(4), body: { kind: "sequence", id: "root-sequence", children: [
      toolNode("read-one", read), toolNode("read-two", read),
      { ...agent("agent-read", "Agent read"), tools: [{ operation: {
        toolName: read.toolName, operationId: read.operationId, contractVersion: 1,
      }, usage: "available" }] },
      toolNode("write", write),
    ] } };
    const catalog = { grantableOperations: [read, write, unused], operations: [] };
    expect(selectedAutomationOperations(workflow, catalog)).toMatchObject({
      mode: "full_plus", operations: [
        { toolName: "reader", operationId: "read" },
        { toolName: "writer", operationId: "write" },
      ], missing: [],
    });
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    document.body.append(root);
    const snapshot = { automations: [{ id: "automation-one", status: "draft" }],
      selectedAutomationId: "automation-one", selectedNodeId: "", selectedRunId: "",
      runs: [], draft: { revision: 4, definition: workflow }, publishedDefinition: null,
      catalog, grant: null, validation: null, error: "", feedback: "", loading: false, mutation: "" };
    const setPermission = vi.fn(async () => true);
    const publishDefinition = vi.fn(async () => true);
    const validate = vi.fn(async () => true);
    createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot, validate, setPermission, publishDefinition },
      confirmDiscard: () => true });
    root.querySelector('[data-action="publish"]')!.dispatch("click");
    await vi.waitFor(() => expect(document.body.querySelector("dialog")?.open).toBe(true));
    const dialog = document.body.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("FULL+ access is required");
    expect(dialog.textContent).toContain("Reader · Read");
    expect(dialog.textContent).toContain("Writer · Write");
    expect(dialog.textContent).not.toContain("Unused");
    expect(validate).toHaveBeenCalledOnce();
    expect(setPermission).not.toHaveBeenCalled();
    dialog.querySelector("form")!.dispatch("submit");
    await vi.waitFor(() => expect(publishDefinition).toHaveBeenCalledOnce());
    expect(setPermission).toHaveBeenCalledExactlyOnceWith("full_plus", [
      { toolName: "reader", operationId: "read", contractVersion: 1 },
      { toolName: "writer", operationId: "write", contractVersion: 1 },
    ]);
  });

  test("activation confirms the published revision even when the draft has newer tools", async () => {
    const publishedOperation = { toolName: "reader", operationId: "read", contractVersion: 1,
      permissionMode: "full_access", label: "Read", input: { properties: {}, required: [] } };
    const draftOperation = { toolName: "writer", operationId: "write", contractVersion: 1,
      permissionMode: "full_plus", label: "Write", input: { properties: {}, required: [] } };
    const node = (operation: typeof publishedOperation) => ({
      kind: "tool", id: operation.toolName, title: operation.toolName,
      onFailure: "stop", operation: { toolName: operation.toolName,
        operationId: operation.operationId, contractVersion: 1 }, controls: {},
    });
    const publishedDefinition = { ...definition(2), body: {
      kind: "sequence", id: "root-sequence", children: [node(publishedOperation)],
    } };
    const draftDefinition = { ...definition(3), body: {
      kind: "sequence", id: "root-sequence", children: [node(draftOperation)],
    } };
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    document.documentElement = document.createElement("html");
    document.body = document.createElement("body");
    const root = document.createElement("section");
    document.body.append(root);
    const snapshot = { automations: [{ id: "automation-one", status: "paused", publishedRevision: 2 }],
      selectedAutomationId: "automation-one", selectedNodeId: "", selectedRunId: "", runs: [],
      draft: { revision: 3, definition: draftDefinition }, publishedDefinition,
      catalog: { grantableOperations: [publishedOperation, draftOperation], operations: [] },
      grant: null, validation: { issues: [{ code: "automation_operation_unavailable", message: "Not granted" }] },
      error: "", feedback: "", loading: false, mutation: "" };
    const setPermission = vi.fn(async () => true);
    const setActive = vi.fn(async () => true);
    createAutomationsWorkspace({ root, documentRoot: document,
      actions: { snapshot: () => snapshot, setPermission, setActive },
      confirmDiscard: () => true });
    root.querySelector('[data-action="toggle-active"]')!.dispatch("click");
    const dialog = document.body.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.textContent).toContain("Published revision 2");
    expect(dialog.textContent).toContain("Reader · Read");
    expect(dialog.textContent).not.toContain("Writer · Write");
    dialog.querySelector("form")!.dispatch("submit");
    await vi.waitFor(() => expect(setActive).toHaveBeenCalledExactlyOnceWith(true));
    expect(setPermission).toHaveBeenCalledExactlyOnceWith("full_access", [
      { toolName: "reader", operationId: "read", contractVersion: 1 },
    ]);
  });

  test("offers a visible editable authoring chat and manual creation", () => {
    const list = renderAutomationList({ automations: [], loading: false, error: "" });
    expect(list).toContain('data-action="describe">Describe your automation');
    expect(list).toContain('data-action="create">Build manually');
    const editor = renderAutomationEditor({
      automations: [], selectedAutomationId: "automation-one", selectedNodeId: "", runs: [],
      draft: { revision: 3, definition: definition(3) },
      catalog: { operations: [], models: [], savedAgents: [] },
      grant: null, validation: null, error: "", feedback: "",
    });
    const document = {} as ConstructorParameters<typeof FakeElement>[1];
    document.createElement = (tag) => new FakeElement(tag, document);
    const root = document.createElement("section");
    root.innerHTML = editor;
    expect(root.querySelector('[data-action="describe"]')?.querySelector("span")?.textContent).toBe("Build with ABot");
    expect(automationAuthoringStarter("automation-one", 3)).toContain("automation-one (draft revision 3)");

    let workspace = "automations";
    const composer = { value: "", focus: vi.fn(), dispatchEvent: vi.fn(),
      ownerDocument: { defaultView: { Event: class { constructor(public type: string) {} } } } };
    const start = vi.fn(() => { workspace = "chat"; });
    expect(openAutomationAuthoringChat({
      dom: { composerInput: composer, newSessionButton: { click: start } },
      shell: { activeWorkspace: () => workspace },
      automationId: "automation-one", revision: 3,
    })).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(composer.value).toContain("automation-one (draft revision 3)");
    expect(composer.focus).toHaveBeenCalledOnce();
    expect(composer.dispatchEvent).toHaveBeenCalledOnce();
    expect(openAutomationAuthoringChat({
      dom: { composerInput: composer, newSessionButton: { click: start } },
      shell: { activeWorkspace: () => workspace }, confirmReplace: () => false,
    })).toBe(false);
    expect(start).toHaveBeenCalledOnce();
  });

  test("selects a newly added agent and saves its template through CAS", async () => {
    const empty = { ...definition(1), body: { kind: "sequence", id: "root-sequence", children: [] } };
    const populated = { ...definition(2), body: { kind: "sequence", id: "root-sequence", children: [agent("new-agent", "New agent")] } };
    const client = {
      supportsAutomations: () => true,
      listAutomations: vi.fn(async () => ({ automations: [{ id: "automation-one", draftRevision: 1 }] })),
      getAutomationDraft: vi.fn(async () => ({ draft: { revision: 1, definition: empty } })),
      getAutomationCatalog: vi.fn(async () => ({ operations: [], models: [], savedAgents: [] })),
      listAutomationRuns: vi.fn(async () => ({ runs: [] })),
      mutateAutomationDraft: vi.fn(async () => ({ draft: { revision: 2, definition: populated } })),
      saveAutomationAgent: vi.fn(async () => ({ agent: { agentId: "saved-one", revision: 1 } })),
    };
    const controller = createAutomationsController({
      client, getEnvironmentId: () => "dev", render: () => {}, isVisible: () => true,
    });
    await controller.openRoute("automation-one");
    expect(await controller.mutateDraft({ kind: "add_node", parentSequenceId: "root-sequence", index: 0,
      nodeWithoutId: { ...agent("ignored", "New agent"), id: undefined } })).toBe(true);
    expect(controller.snapshot().selectedNodeId).toBe("new-agent");
    expect(await controller.saveAgent()).toBe(true);
    expect(client.saveAutomationAgent).toHaveBeenCalledExactlyOnceWith(
      "automation-one", "new-agent", 2, "dev",
    );
  });

  test("confirms rerun using the frozen revision and actual prior input versions", async () => {
    const confirmation = automationRerunConfirmation({
      definitionRevision: 7,
      report: { inputVersions: [
        { inputId: "input-a", canonicalPath: "/invoices/a.pdf", contentVersion: "sha256:abc" },
        { inputId: "input-b", canonicalPath: "/invoices/b.pdf", contentVersion: "sha256:def" },
      ] },
    });
    expect(confirmation).toContain("definition revision 7");
    expect(confirmation).toContain("/invoices/a.pdf — sha256:abc");
    expect(confirmation).toContain("/invoices/b.pdf — sha256:def");
    expect(confirmation).toContain("Earlier successful external actions may happen again");

    const calls: { path: string; options?: { body?: string } }[] = [];
    const api = createAutomationRequests({
      requestApi: async (path: string, options?: { body?: string }) => {
        calls.push({ path, options });
        return {};
      },
      getEnvironmentId: () => "dev", getConfig: () => ({ backend: "runtime" }),
    });
    await api.rerunAutomationRun("run-one", "once-key", "dev");
    expect(calls[0]?.path).toBe("/automation-runs/run-one/rerun?environment=dev");
    expect(JSON.parse(calls[0]!.options!.body!)).toEqual({
      idempotencyKey: "once-key", confirmed: true,
    });
  });

  test("sends the current draft revision with a single focused graph mutation", async () => {
    const client = {
      supportsAutomations: () => true,
      listAutomations: vi.fn(async () => ({ automations: [{ id: "automation-one", draftRevision: 4 }] })),
      getAutomationDraft: vi.fn(async () => ({ draft: { revision: 4, definition: definition(4) },
        validation: [{ code: "automation_graph_invalid", path: "nodes.first", message: "Check this step" }],
      })),
      getAutomationCatalog: vi.fn(async () => ({ operations: [], grantableOperations: [], models: [], savedAgents: [] })),
      listAutomationRuns: vi.fn(async () => ({ runs: [] })),
      validateAutomation: vi.fn(async () => ({ issues: [
        { code: "automation_graph_invalid", path: "nodes.first", message: "Check this step" },
      ] })),
      mutateAutomationDraft: vi.fn(async () => ({ draft: { revision: 5, definition: definition(5) } })),
      getAutomationRun: vi.fn(async () => ({ run: { id: "wrong", automationId: "another-automation" } })),
    };
    const controller = createAutomationsController({
      client, getEnvironmentId: () => "dev", render: () => {}, isVisible: () => true,
    });
    await controller.openRoute("automation-one");
    expect(controller.snapshot().validation?.issues).toHaveLength(1);
    expect(renderAutomationEditor(controller.snapshot())).not.toContain("Needs attention before publishing");
    expect(await controller.validate()).toBe(true);
    expect(renderAutomationEditor(controller.snapshot())).toContain("Needs attention before publishing");
    expect(await controller.mutateDraft({ kind: "remove_node", nodeId: "second" })).toBe(true);
    expect(client.mutateAutomationDraft).toHaveBeenCalledExactlyOnceWith(
      "automation-one", 4, { kind: "remove_node", nodeId: "second" }, "dev",
    );
    expect(controller.snapshot().draft.revision).toBe(5);
    expect(renderAutomationEditor(controller.snapshot())).not.toContain("Needs attention before publishing");
    expect(await controller.openRun("wrong")).toBe(false);
    expect(controller.snapshot().selectedRunId).toBe("");
  });

  test("keeps user grant and publish actions separate from draft mutations", async () => {
    const calls: { path: string; options?: { method?: string; body?: string } }[] = [];
    const api = createAutomationRequests({
      requestApi: async (path: string, options?: { method?: string; body?: string }) => {
        calls.push({ path, options });
        return {};
      },
      getEnvironmentId: () => "dev", getConfig: () => ({ backend: "runtime" }),
    });
    await api.mutateAutomationDraft("one", 7, { kind: "update_definition", patch: { title: "New" } });
    await api.setAutomationPermission("one", {
      expectedGrantRevision: 2, mode: "full_plus",
      operations: [{ toolName: "files", operationId: "write", contractVersion: 1 }],
    });
    await api.publishAutomation("one", 7);
    await api.saveAutomationAgent("one", "agent-step", 7);
    expect(calls.map(({ options }) => options?.method)).toEqual(["PATCH", "PUT", "POST", "POST"]);
    expect(JSON.parse(calls[0]!.options!.body!)).toEqual({
      expectedRevision: 7, mutation: { kind: "update_definition", patch: { title: "New" } },
    });
    expect(JSON.parse(calls[1]!.options!.body!)).toEqual({
      expectedGrantRevision: 2, mode: "full_plus",
      operations: [{ toolName: "files", operationId: "write", contractVersion: 1 }],
    });
    expect(calls[2]!.path).toBe("/automations/one/publish?environment=dev");
    expect(JSON.parse(calls[2]!.options!.body!)).toEqual({ expectedRevision: 7 });
    expect(calls[3]!.path).toBe("/automations/one/agents?environment=dev");
    expect(JSON.parse(calls[3]!.options!.body!)).toEqual({
      nodeId: "agent-step", expectedRevision: 7,
    });
  });
});
