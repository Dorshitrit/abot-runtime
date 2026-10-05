import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createAutomationsWorkspace } from "../../web-ui/app/components/automations/workspace.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { renderAutomationStepPreview } from "../../web-ui/app/components/automations/step-preview.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";

const agent = { id: "agent-one", kind: "agent", title: "Summarize", modelProfileId: "local",
  agentMode: "fast", onFailure: "stop", inputs: {}, tools: [], result: { kind: "text" },
  prompt: "Summarize the supplied information", roleInstructions: "Be concise" };

function fixture(leaf: Record<string, unknown> = agent, operations: Record<string, unknown>[] = [],
  body = { kind: "sequence", id: "root", children: [structuredClone(leaf)] }) {
  const document = { activeElement: null } as ConstructorParameters<typeof FakeElement>[1];
  document.createElement = (tag) => new FakeElement(tag, document);
  document.documentElement = document.createElement("html");
  document.body = document.createElement("body");
  const root = document.createElement("section");
  const html = Object.getOwnPropertyDescriptor(FakeElement.prototype, "innerHTML")!;
  Object.defineProperty(root, "innerHTML", {
    get: () => html.get!.call(root),
    set(value: string) {
      html.set!.call(root, value);
      for (const node of root.querySelectorAll("*"))
        Object.assign(node, { getAttribute: (name: string) => node.attributes.get(name) ?? null });
    },
  });
  document.body.append(root);
  let navigationRevision = 1;
  const snapshot = { automations: [{ id: "automation-one", status: "draft" }],
    selectedAutomationId: "automation-one", selectedRunId: "", selectedNodeId: "", runs: [],
    draft: { revision: 1, definition: { title: "Brief", trigger: { kind: "manual" },
      body } },
    catalog: { operations, savedAgents: [], models: [{ id: "local", label: "Local" }] },
    loading: false, mutation: "", error: "", feedback: "" };
  let workspace: ReturnType<typeof createAutomationsWorkspace>;
  const saveNode = vi.fn(async (_nodeId: string, _patch: Record<string, unknown>) => true);
  const actions = { snapshot: () => snapshot, navigationRevision: () => navigationRevision,
    saveNode, selectNode: (id: string) => { snapshot.selectedNodeId = id; workspace.render(snapshot); } };
  workspace = createAutomationsWorkspace({ root, documentRoot: document, actions, confirmDiscard: () => true });
  vi.stubGlobal("FormData", class {
    constructor(private form: FakeElement) {}
    get(name: string) {
      const field = this.form.querySelector(`[name="${name}"]`);
      if (!field) return null;
      if (field.value) return field.value;
      if (field.tagName === "TEXTAREA") return field.textContent;
      if (field.tagName === "SELECT")
        return (field.querySelector("[selected]") || field.querySelector("option"))?.attributes.get("value") || "";
      return field.value;
    }
  });
  function open() {
    root.querySelector('[data-automation-node="agent-one"]')!.dispatch("click");
    root.querySelector('[data-action="edit-step"]')!.dispatch("click");
    return document.body.querySelector("dialog")!;
  }
  return { root, document, snapshot, workspace, saveNode, open,
    navigate: () => { navigationRevision += 1; workspace.render(snapshot); } };
}

afterEach(() => vi.unstubAllGlobals());

describe("automation step preview and modal editor", () => {
  it("shows named inputs and a bounded prompt without editable fields or raw binding IDs", () => {
    const markup = renderAutomationStepPreview({ ...agent, prompt: "<unsafe> " + "a".repeat(300),
      inputs: { source: { kind: "node_result", nodeId: "internal-id", select: "data", pointer: "/items" },
        file: { kind: "run_file", fileName: "brief.md" } } }, {},
    [{ id: "internal-id", title: "Read sources" }]);
    expect(markup).toContain("Read sources · data · /items");
    expect(markup).toContain("New file each run · brief.md");
    expect(markup).not.toContain("internal-id");
    expect(markup).toContain("&lt;unsafe&gt;");
    expect(markup).not.toContain("a".repeat(200));
    expect(markup).not.toContain("<form");
  });

  it("opens only a preview on card click, then opens the body-mounted modal explicitly", () => {
    const { root, document } = fixture();
    root.querySelector('[data-automation-node="agent-one"]')!.dispatch("click");
    expect(root.querySelector(".automation-step-preview")).not.toBeNull();
    expect(document.body.querySelector("dialog")).toBeNull();
    root.querySelector('[data-action="edit-step"]')!.dispatch("click");
    const dialog = document.body.querySelector("dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('[data-step-direction="-1"]')!.attributes.get("aria-label")).toBe("Previous step");
    expect(dialog.querySelector('[data-action="move-up"]')!.attributes.get("aria-label")).toBe("Move step earlier in workflow");
    expect(dialog.textContent).toContain("Workflow changes are saved to the draft immediately.");
    expect(dialog.parentElement).toBe(document.body);
    expect(root.contains(dialog)).toBe(false);
    expect(document.activeElement).toBe(dialog.querySelector('[name="title"]'));
  });

  it("preserves the dirty form, focus and scroll across changed live snapshots", () => {
    const { open, workspace, snapshot, document } = fixture();
    const dialog = open(), input = dialog.querySelector('[name="title"]')!;
    input.value = "Unsaved title";
    input.dispatch("input");
    input.focus();
    const content = dialog.querySelector(".automation-step-dialog-content")!;
    content.scrollTop = 480;
    workspace.render({ ...snapshot, feedback: "A run finished." });
    expect(document.body.querySelector("dialog")).toBe(dialog);
    expect(dialog.querySelector('[name="title"]')).toBe(input);
    expect(input.value).toBe("Unsaved title");
    expect(document.activeElement).toBe(input);
    expect(content.scrollTop).toBe(480);
    expect(workspace.isDirty()).toBe(true);
  });

  it("guards Escape and navigation with Save, Discard and Keep editing, without saving implicitly", () => {
    const { open, workspace, saveNode, document } = fixture();
    const dialog = open(), input = dialog.querySelector('[name="title"]')!;
    input.value = "Unsaved";
    input.dispatch("input");
    expect(dialog.dispatch("cancel").preventDefault).toHaveBeenCalledOnce();
    expect(dialog.querySelector("[data-step-discard]")!.hidden).toBe(false);
    expect(document.activeElement).toBe(dialog.querySelector("[data-step-keep]"));
    dialog.querySelector("[data-step-keep]")!.dispatch("click");
    expect(dialog.querySelector("[data-step-discard]")!.hidden).toBe(true);
    expect(workspace.prepareLeave()).toBe(false);
    dialog.querySelector("[data-step-discard-confirm]")!.dispatch("click");
    expect(document.body.querySelector("dialog")).toBeNull();
    expect(workspace.isDirty()).toBe(false);
    expect(workspace.prepareLeave()).toBe(true);
    expect(saveNode).not.toHaveBeenCalled();
  });

  it("saves the edited step once, closes and restores focus to the current preview", async () => {
    const { open, root, saveNode, document, workspace, snapshot } = fixture();
    const dialog = open(), input = dialog.querySelector('[name="title"]')!;
    input.value = "Revised title";
    input.dispatch("input");
    workspace.render({ ...snapshot, feedback: "Updated run" });
    dialog.querySelector(".automation-step-dialog-footer")!.querySelector("[data-step-save]")!.dispatch("click");
    await vi.waitFor(() => expect(document.body.querySelector("dialog")).toBeNull());
    expect(saveNode).toHaveBeenCalledExactlyOnceWith("agent-one", expect.objectContaining({ title: "Revised title" }));
    expect(document.activeElement).toBe(root.querySelector('[data-automation-node="agent-one"]'));
  });

  it("keeps changes and actionable feedback when saving fails", async () => {
    const { open, saveNode, document, workspace } = fixture();
    saveNode.mockResolvedValue(false);
    const dialog = open(), input = dialog.querySelector('[name="title"]')!;
    input.value = "Keep this";
    input.dispatch("input");
    dialog.querySelector(".automation-step-dialog-footer")!.querySelector("[data-step-save]")!.dispatch("click");
    await vi.waitFor(() => expect(saveNode).toHaveBeenCalledOnce());
    expect(document.body.querySelector("dialog")).toBe(dialog);
    expect(input.value).toBe("Keep this");
    expect(workspace.isDirty()).toBe(true);
    expect(dialog.textContent).toContain("Your changes are still here");
    expect(dialog.querySelector('[data-step-direction="-1"]')!.disabled).toBe(true);
  });

  it("keeps the pending save owned by its original editor and prevents duplicate save or discard", async () => {
    const { open, saveNode, snapshot, workspace, document, root } = fixture();
    let complete!: (saved: boolean) => void;
    saveNode.mockImplementation(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    const dialog = open();
    root.scrollTop = 340;
    const viewport = root.querySelector("[data-camera-viewport]")!;
    viewport.scrollTop = 180;
    Object.assign(viewport, { scrollLeft: 260 });
    dialog.querySelector('[name="title"]')!.dispatch("input");
    dialog.dispatch("cancel");
    dialog.querySelector("[data-step-save]")!.dispatch("click");
    expect(saveNode).toHaveBeenCalledOnce();
    expect(workspace.prepareLeave()).toBe(false);
    dialog.querySelector("[data-step-discard-confirm]")!.dispatch("click");
    dialog.querySelector("[data-step-save]")!.dispatch("click");
    expect(document.body.querySelector("dialog")).toBe(dialog);
    snapshot.draft.revision += 1;
    workspace.render(snapshot);
    complete(true);
    await vi.waitFor(() => expect(document.body.querySelector("dialog")).toBeNull());
    expect(saveNode).toHaveBeenCalledOnce();
    expect(root.scrollTop).toBe(340);
    const restored = root.querySelector("[data-camera-viewport]")! as FakeElement & { scrollLeft: number };
    expect(restored.scrollTop).toBe(180);
    expect(restored.scrollLeft).toBe(260);
  });

  it("owns operation changes inside the modal and saves their newly configured inputs", async () => {
    const identity = { toolName: "reader", operationId: "read", contractVersion: 1 };
    const operation = { ...identity, label: "Read content", input: { type: "object",
      properties: { path: { type: "string" } }, required: ["path"] } };
    const { open, saveNode, document } = fixture({ id: "agent-one", kind: "tool", title: "Gather material",
      onFailure: "stop", operation: { ...identity, operationId: "" }, controls: {} }, [operation]);
    const dialog = open(), choice = dialog.querySelector('[name="toolOperation"]')!;
    const heading = dialog.querySelector(".automation-step-dialog-heading")!;
    expect(heading.querySelector("h2")!.textContent).toBe("Gather material");
    expect(heading.querySelector(".automation-tool-identity-name")!.textContent).toBe("Reader");
    expect(heading.querySelector(".automation-tool-identity-operation")!.textContent).toBe("Choose an operation");
    choice.value = JSON.stringify([identity.toolName, identity.operationId, identity.contractVersion]);
    for (const handler of dialog.listeners.get("change") || [])
      handler({ type: "change", target: choice });
    expect(heading.querySelector(".automation-tool-identity-operation")!.textContent).toBe("Read");
    const row = dialog.querySelector("[data-binding-row]")!;
    expect(row.querySelector("[data-binding-key]")!.value).toBe("path");
    row.querySelector("[data-binding-kind]")!.value = "literal";
    const value = row.querySelector("[data-binding-value]")!;
    value.value = "/workspace/brief.txt";
    value.dispatch("input");
    dialog.querySelector(".automation-step-dialog-footer")!.querySelector("[data-step-save]")!.dispatch("click");
    await vi.waitFor(() => expect(document.body.querySelector("dialog")).toBeNull());
    expect(saveNode).toHaveBeenCalledExactlyOnceWith("agent-one", expect.objectContaining({
      operation: identity, controls: { path: { kind: "literal", value: "/workspace/brief.txt" } },
    }));
  });

  it("refuses to overwrite a newer revision and dismisses after a different navigation identity", () => {
    const { open, snapshot, workspace, saveNode, document, navigate } = fixture();
    const dialog = open();
    dialog.querySelector('[name="title"]')!.dispatch("input");
    snapshot.draft.revision = 2;
    workspace.render(snapshot);
    dialog.querySelector(".automation-step-dialog-footer")!.querySelector("[data-step-save]")!.dispatch("click");
    expect(saveNode).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain("close and reopen");
    navigate();
    expect(document.body.querySelector("dialog")).toBeNull();
  });

  it("locks wheel, keyboard and reset for an open preview or modal, then restores zoom after the card closes", () => {
    const { root, document } = fixture();
    const viewport = () => {
      const element = root.querySelector("[data-camera-viewport]")!;
      Object.assign(element, { clientWidth: 600, clientHeight: 500,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 500 }) });
      return element;
    };
    const key = (value: string) => {
      for (const handler of root.listeners.get("keydown") || [])
        handler({ target: viewport(), key: value, preventDefault: vi.fn() });
    };
    const wheel = (deltaY: number) => {
      for (const handler of root.listeners.get("wheel") || [])
        handler({ target: viewport(), deltaY, deltaMode: 0, clientX: 200, clientY: 200, preventDefault: vi.fn() });
    };
    const expectLocked = () => {
      key("+"); key("="); key("-"); key("0"); wheel(-120); wheel(120);
      expect(root.querySelector("[data-camera-level]")!.textContent).toBe("120%");
    };
    key("+");
    expect(root.querySelector("[data-camera-level]")!.textContent).toBe("120%");
    root.querySelector('[data-automation-node="agent-one"]')!.dispatch("click");
    expectLocked();
    root.querySelector('[data-action="edit-step"]')!.dispatch("click");
    expectLocked();
    document.body.querySelector("dialog")!.dispatch("cancel");
    expectLocked();
    root.querySelector('[data-select-node=""]')!.dispatch("click");
    key("0");
    expect(root.querySelector("[data-camera-level]")!.textContent).toBe("100%");
    wheel(-120);
    expect(root.querySelector("[data-camera-level]")!.textContent).toBe("109%");
    wheel(120);
    expect(root.querySelector("[data-camera-level]")!.textContent).toBe("100%");
  });
});

function navigationFixture() {
  const second = { ...agent, id: "agent-two", title: "Review", inputs: {
    source: { kind: "node_result", nodeId: "agent-one", select: "text" },
  } };
  const third = { ...agent, id: "agent-three", title: "Other branch" };
  const last = { ...agent, id: "agent-four", title: "After join" };
  return fixture(agent, [], { kind: "sequence", id: "root", children: [agent,
    { kind: "parallel", id: "fork", branches: [
      { kind: "sequence", id: "left", children: [second] },
      { kind: "sequence", id: "right", children: [third] },
    ] }, last] });
}

describe("automation modal step navigation", () => {
  it("navigates workflow leaf order including parallel branches without closing or saving", () => {
    const { open, snapshot, document, root, saveNode } = navigationFixture();
    const dialog = open();
    root.scrollTop = 250;
    const viewport = root.querySelector("[data-camera-viewport]")!;
    viewport.scrollTop = 150;
    Object.assign(viewport, { scrollLeft: 320 });
    dialog.querySelector(".automation-step-dialog-content")!.scrollTop = 420;
    expect(dialog.querySelector('[data-step-direction="-1"]')!.disabled).toBe(true);
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("agent-two");
    expect(document.body.querySelector("dialog")).toBe(dialog);
    expect(dialog.querySelector('[name="title"]')!.value).toBe("Review");
    expect(dialog.querySelector(".automation-step-dialog-content")!.scrollTop).toBe(0);
    expect(document.activeElement).toBe(dialog.querySelector('[data-step-direction="1"]'));
    const selectedProducer = dialog.querySelector("[data-binding-value]")!.querySelector("[selected]")!;
    expect(selectedProducer.attributes.get("value")).toBe("agent-one");
    expect(root.scrollTop).toBe(250);
    const restored = root.querySelector("[data-camera-viewport]")! as FakeElement & { scrollLeft: number };
    expect(restored.scrollTop).toBe(150);
    expect(restored.scrollLeft).toBe(320);
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("agent-three");
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("agent-four");
    expect(dialog.querySelector('[data-step-direction="1"]')!.disabled).toBe(true);
    dialog.querySelector('[data-step-direction="-1"]')!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("agent-three");
    expect(saveNode).not.toHaveBeenCalled();
  });

  it("retains dirty fields on Keep editing and discards them only on Discard & continue", () => {
    const { open, snapshot, saveNode, workspace } = navigationFixture();
    const dialog = open(), title = dialog.querySelector('[name="title"]')!;
    title.value = "Unsaved title";
    title.dispatch("input");
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("agent-one");
    expect(dialog.querySelector("[data-step-discard-confirm]")!.textContent).toBe("Discard & continue");
    dialog.querySelector("[data-step-keep]")!.dispatch("click");
    expect(title.value).toBe("Unsaved title");
    expect(workspace.isDirty()).toBe(true);
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    dialog.querySelector("[data-step-discard-confirm]")!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("agent-two");
    expect(workspace.isDirty()).toBe(false);
    dialog.querySelector('[data-step-direction="-1"]')!.dispatch("click");
    expect(dialog.querySelector('[name="title"]')!.value).toBe("Summarize");
    expect(saveNode).not.toHaveBeenCalled();
  });

  it("saves only the original node then continues in the same modal using the new revision", async () => {
    const { open, snapshot, saveNode, workspace, document } = navigationFixture();
    saveNode.mockImplementation(async (_id, patch) => {
      snapshot.draft.definition.body.children[0] = { ...snapshot.draft.definition.body.children[0], ...patch };
      snapshot.draft.revision += 1;
      workspace.render(snapshot);
      return true;
    });
    const dialog = open(), title = dialog.querySelector('[name="title"]')!;
    title.value = "Saved title";
    title.dispatch("input");
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    expect(dialog.querySelector("[data-step-guard-save]")!.textContent).toBe("Save & continue");
    dialog.querySelector("[data-step-guard-save]")!.dispatch("click");
    await vi.waitFor(() => expect(snapshot.selectedNodeId).toBe("agent-two"));
    expect(saveNode).toHaveBeenCalledExactlyOnceWith("agent-one", expect.objectContaining({ title: "Saved title" }));
    expect(document.body.querySelector("dialog")).toBe(dialog);
    expect(workspace.isDirty()).toBe(false);
    dialog.querySelector('[data-step-direction="-1"]')!.dispatch("click");
    expect(dialog.querySelector('[name="title"]')!.value).toBe("Saved title");
  });

  it("blocks a second navigation while saving and preserves the intended destination", async () => {
    const { open, snapshot, saveNode } = navigationFixture();
    let complete!: (saved: boolean) => void;
    saveNode.mockImplementation(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    const dialog = open();
    dialog.querySelector('[name="title"]')!.dispatch("input");
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    dialog.querySelector("[data-step-guard-save]")!.dispatch("click");
    expect(dialog.querySelector('[data-step-direction="1"]')!.disabled).toBe(true);
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("agent-one");
    complete(true);
    await vi.waitFor(() => expect(snapshot.selectedNodeId).toBe("agent-two"));
    expect(saveNode).toHaveBeenCalledOnce();
  });

  it("does not use a stale order or discard edits when the draft changes during a navigation guard", () => {
    const { open, snapshot, workspace, saveNode } = navigationFixture();
    const dialog = open(), title = dialog.querySelector('[name="title"]')!;
    title.value = "Keep this";
    title.dispatch("input");
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    snapshot.draft.revision += 1;
    snapshot.draft.definition.body.children.reverse();
    workspace.render(snapshot);
    dialog.querySelector("[data-step-discard-confirm]")!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("agent-one");
    expect(title.value).toBe("Keep this");
    expect(workspace.isDirty()).toBe(true);
    dialog.querySelector("[data-step-guard-save]")!.dispatch("click");
    expect(saveNode).not.toHaveBeenCalled();
    dialog.querySelector("[data-step-keep]")!.dispatch("click");
    dialog.querySelector('[data-step-direction="1"]')!.dispatch("click");
    expect(snapshot.selectedNodeId).toBe("agent-one");
    expect(dialog.textContent).toContain("Close and reopen");
  });
});
