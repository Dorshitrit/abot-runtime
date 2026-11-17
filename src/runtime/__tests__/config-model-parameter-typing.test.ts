import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser module has no declaration surface.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser module has no declaration surface.
import { createConfigWorkspaceMutations } from "../../web-ui/app/components/config-workspace/workspace-mutations.js";
// @ts-expect-error Browser module has no declaration surface.
import { createConfigWorkspaceEvents } from "../../web-ui/app/components/config-workspace/workspace-events.js";
// @ts-expect-error Browser module has no declaration surface.
import { createModelParameterEdits } from "../../web-ui/app/components/config-workspace/model-parameter-edits.js";
// @ts-expect-error Browser module has no declaration surface.
import { createModelParameterPreview } from "../../web-ui/app/components/config-workspace/model-parameter-preview.js";
// @ts-expect-error Browser module has no declaration surface.
import { createConfigWorkspacePersistence } from "../../web-ui/app/components/config-workspace/workspace-persistence.js";
// @ts-expect-error Browser module has no declaration surface.
import { modelParameterPresentation, renderModelParameters } from "../../web-ui/app/components/config-workspace/model-parameters.js";

type TestElement = Record<string, any>;
type Listener = (event: { target: TestElement }) => void;
type PreviewRequest = { candidate: any; resolve: (value: unknown) => void };

function field(key: string, type = "number") {
  return { key, label: key, type, supported: true, modelSupport: "supported", explicit: false,
    omitted: true, source: "server", description: "Parameter", warnings: [], recommended: 1 };
}

/** The existing DOM characterization approach models replacement as new nodes. */
function harness() {
  const model = createConfigWorkspaceModel();
  const file = { kind: "model", id: "selected", config: { provider: "local", model: "generic", contextWindowTokens: 4096,
    generation: { parameters: { temperature: { mode: "value", value: 0.2 } } } } };
  const initialPresentation = { model: { parameters: [field("max_output_tokens", "int"), field("temperature"),
    { ...field("top_p"), label: "Top P", min: 0, max: 1 }], warnings: [] }, calibration: {} };
  model.state.configDashboard = { files: {
    runtime: { kind: "runtime", id: "runtime", config: { models: { providers: { local: { type: "llamacpp" }, remote: { type: "openai-chatgpt" } } } } }, models: [file],
  }, modelParameters: { selected: structuredClone(initialPresentation) } };
  model.state.selectedConfigModelId = file.id;
  model.captureBaselines();
  const listeners = new Map<string, Listener[]>();
  const document = { activeElement: null as TestElement | null };
  let nodes: Record<string, TestElement> = {};
  let renders = 0;
  const root = {
    ownerDocument: document,
    addEventListener(type: string, listener: Listener) { listeners.set(type, [...listeners.get(type) ?? [], listener]); },
    dispatch(type: string, target: TestElement) { for (const listener of listeners.get(type) ?? []) listener({ target }); },
    contains(element: TestElement) { return Object.values(nodes).includes(element); },
    querySelector() { return null; },
    querySelectorAll(selector: string) {
      if (selector.includes("model-parameters-recommended")) return [nodes.recommended];
      if (selector === "[data-config-action]") return Object.values(nodes);
      return [];
    },
  };
  function element(dataset: Record<string, string>, value = "", tag = "input"): TestElement {
    const node: TestElement = { dataset, value, disabled: false, validity: { badInput: false },
      setCustomValidity(message: string) { node.validationMessage = message; },
      setAttribute(name: string, value: string) { node[name] = value; },
      removeAttribute(name: string) { delete node[name]; }, reportValidity: vi.fn(),
      focus() { if (!node.disabled) document.activeElement = node; },
      matches() { return tag === "select"; },
      closest(selector: string) { return selector === "[data-config-action]" ? node : null; },
    };
    return node;
  }
  function renderConfigDashboard() {
    renders += 1;
    document.activeElement = null;
    const generation = file.config.generation as any;
    const parameter = (key: string) => element({ configAction: "model-parameter-value", kind: "model", id: file.id,
      generationPath: '["generation"]', parameterKey: key }, String(generation.parameters?.[key]?.value ?? ""));
    nodes = {
      number: parameter("max_output_tokens"), decimal: parameter("temperature"), topP: parameter("top_p"),
      context: element({ configAction: "field", kind: "model", id: file.id, path: '["contextWindowTokens"]', valueType: "number" }, String(file.config.contextWindowTokens)),
      modelName: element({ configAction: "field", kind: "model", id: file.id, path: '["model"]', valueType: "string" }, file.config.model),
      provider: element({ configAction: "field", kind: "model", id: file.id, path: '["provider"]', valueType: "string" }, file.config.provider, "select"),
      mode: element({ configAction: "model-parameter-mode", kind: "model", id: file.id, generationPath: '["generation"]', parameterKey: "temperature" }, "value", "select"),
      recommended: element({ configAction: "model-parameters-recommended", kind: "model", id: file.id, generationPath: '["generation"]' }, "", "button"),
    };
    const metadata = model.state.configDashboard.modelParameters.selected.model;
    nodes.recommended.disabled = Boolean(metadata.pending || metadata.stale);
  }
  renderConfigDashboard();
  const requests: PreviewRequest[] = [];
  const previewParameters = (candidate: unknown) => new Promise((resolve) => requests.push({ candidate: structuredClone(candidate), resolve }));
  const preview = createModelParameterPreview({ state: model.state, root, previewParameters, renderConfigDashboard,
    reconcileDrafts: (modelId: string, presentation: any) => edits.reconcileDrafts(modelId, presentation) });
  const dom = { configDashboard: root, refreshConfigButton: { addEventListener() {} } };
  const setWorkspaceStatus = vi.fn();
  const confirmDiscard = vi.fn(async () => true);
  const mutations = createConfigWorkspaceMutations({ ...model, dom, renderConfigDashboard,
    setWorkspaceStatus, syncDirtyPresentation: vi.fn(), recordControlEvent: vi.fn(), confirmDiscard });
  const edits = createModelParameterEdits({ ...model, mutateConfigFile: mutations.mutateConfigFile,
    refreshPreview: preview.refresh, renderConfigDashboard, setWorkspaceStatus, syncDirtyPresentation: vi.fn() });
  const saveFile = vi.fn(async (_input: unknown) => ({}));
  const persistence = createConfigWorkspacePersistence({ ...model, ...mutations, state: model.state, dom, saveFile,
    setWorkspaceStatus, refreshParameterPreview: vi.fn(), recordControlEvent: vi.fn(),
    syncDashboardInteractivity: vi.fn(), syncDirtyPresentation: vi.fn() });
  createConfigWorkspaceEvents({ ...model, ...mutations, dom, eventTarget: { addEventListener() {} },
    parameterEdits: edits, invalidateParameterPreview: preview.invalidate, refreshParameterPreview: preview.refresh,
    renderConfigDashboard, syncDirtyPresentation: vi.fn(), setWorkspaceStatus: vi.fn(),
  }).bind();
  async function settle(index: number, transform = (_presentation: any) => {}) {
    const presentation = structuredClone(initialPresentation);
    transform(presentation);
    requests[index].resolve({ presentation });
    await Promise.resolve(); await Promise.resolve();
  }
  function type(node: TestElement, value: string, badInput = false) {
    node.value = value; node.validity.badInput = badInput;
    root.dispatch("input", node);
  }
  return { model, file, root, document, requests, settle, type, persistence, saveFile, setWorkspaceStatus,
    confirmDiscard, prepareDiscardChanges: mutations.prepareDiscardChanges,
    node: (name: string) => nodes[name], renders: () => renders };
}

describe("model parameter typing through workspace events and preview", () => {
  test("keeps the same enabled focused number input through multiple digits and previews only the committed value", async () => {
    const h = harness();
    const input = h.node("number"); input.focus();
    for (const value of ["1", "12", "123"]) {
      h.type(input, value);
      expect(h.node("number")).toBe(input);
      expect(h.document.activeElement).toBe(input);
      expect(input.disabled).toBe(false);
    }
    expect(h.renders()).toBe(1);
    expect(h.requests).toHaveLength(0);
    expect(h.file.config.generation).toHaveProperty("parameters.max_output_tokens", { mode: "value", value: 123 });
    h.root.dispatch("change", input);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].candidate.models[0].generation.parameters.max_output_tokens.value).toBe(123);
    expect(h.node("number")).toBe(input);
    await h.settle(0);
    expect(h.renders()).toBe(2);
  });

  test("retains decimal intermediate text without replacing the input", () => {
    const h = harness(); const input = h.node("decimal"); input.focus();
    for (const value of ["0", "0.", "0.25"]) h.type(input, value);
    expect(h.node("decimal")).toBe(input);
    expect(h.document.activeElement).toBe(input);
    expect(input.value).toBe("0.25");
    expect(h.renders()).toBe(1);
    expect(h.requests).toHaveLength(0);
    expect(h.file.config.generation.parameters.temperature.value).toBe(0.25);
    h.root.dispatch("change", input);
    expect(h.requests[0].candidate.models[0].generation.parameters.temperature.value).toBe(0.25);
  });

  test("typing an invalid intermediate number invalidates an older request even when canonical config is unchanged", async () => {
    const h = harness();
    h.type(h.node("number"), "12"); h.root.dispatch("change", h.node("number"));
    const input = h.node("decimal"); input.focus();
    const before = JSON.stringify(h.file.config);
    h.type(input, "", true);
    expect(JSON.stringify(h.file.config)).toBe(before);
    expect(h.node("recommended").disabled).toBe(true);
    await h.settle(0);
    expect(h.renders()).toBe(1);
    expect(h.node("decimal")).toBe(input);
    expect(h.document.activeElement).toBe(input);
    expect(input.disabled).toBe(false);
    h.type(input, "0.75"); h.root.dispatch("change", input);
    expect(h.requests).toHaveLength(2);
    await h.settle(1);
    expect(h.renders()).toBe(2);
    expect(h.node("recommended").disabled).toBe(false);
  });

  test("ordinary numeric and text fields update drafts on input and commit previews on change", async () => {
    const h = harness(); const context = h.node("context"); context.focus();
    for (const value of ["8", "81", "8192"]) h.type(context, value);
    expect(h.file.config.contextWindowTokens).toBe(8192);
    expect(h.node("context")).toBe(context);
    expect(h.requests).toHaveLength(0);
    h.root.dispatch("change", context);
    expect(h.requests).toHaveLength(1);
    const name = h.node("modelName"); name.focus(); h.type(name, "new-target");
    await h.settle(0);
    expect(h.node("modelName")).toBe(name);
    expect(h.document.activeElement).toBe(name);
    expect(name.value).toBe("new-target");
    expect(h.renders()).toBe(1);
    h.root.dispatch("change", name);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].candidate.models[0].model).toBe("new-target");
  });

  test("stale recommendations stay blocked while mode selections still commit a fresh preview", () => {
    const h = harness(); h.type(h.node("decimal"), "0.4");
    const before = JSON.stringify(h.file.config);
    h.root.dispatch("click", h.node("recommended"));
    expect(JSON.stringify(h.file.config)).toBe(before);
    expect(h.requests).toHaveLength(0);
    const mode = h.node("mode"); mode.value = "omit";
    h.root.dispatch("change", mode);
    expect(h.file.config.generation.parameters.temperature).toEqual({ mode: "omit" });
    expect(h.requests).toHaveLength(1);
  });

  test("an out-of-range final value cannot save its valid typing prefix and remains editable", async () => {
    const h = harness(); const input = h.node("topP"); input.focus();
    h.type(input, "1"); h.type(input, "1.5"); h.root.dispatch("change", input);
    expect(h.node("topP")).toBe(input);
    expect(h.document.activeElement).toBe(input);
    expect(input.disabled).toBe(false);
    await expect(h.persistence.saveConfigFile("model", "selected")).resolves.toBe(false);
    expect(h.saveFile).not.toHaveBeenCalled();
    expect(input.validationMessage).toContain("Top P");
    expect(h.requests).toHaveLength(0);
    expect(h.setWorkspaceStatus).toHaveBeenLastCalledWith(expect.stringContaining("Top P"), "error-text");
    const metadata = modelParameterPresentation(h.model.state, h.file, ["generation"]);
    expect(renderModelParameters(h.file, ["generation"], metadata)).toMatch(/aria-label="Top P value"[^>]+value="1.5"/u);
    h.type(input, "0.75"); h.root.dispatch("change", input);
    expect(input.validationMessage).toBe("");
    await expect(h.persistence.saveConfigFile("model", "selected")).resolves.toBe(true);
    expect(h.saveFile).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ generation: expect.objectContaining({
      parameters: expect.objectContaining({ top_p: { mode: "value", value: 0.75 } }),
    }) }) }));
  });

  test("invalid drafts remain dirty across metadata refresh and reset with their config", () => {
    const h = harness(); const input = h.node("topP");
    h.type(input, "1"); h.model.captureBaselines();
    expect(h.model.isFileDirty(h.file)).toBe(false);
    h.type(input, "1.5");
    expect(h.model.isFileDirty(h.file)).toBe(true);
    const metadata = h.model.state.configDashboard.modelParameters.selected;
    h.model.state.configDashboard.modelParameters.selected = structuredClone(metadata);
    const projected = modelParameterPresentation(h.model.state, h.file, ["generation"]);
    expect(projected.parameters.find((item: any) => item.key === "top_p").editingText).toBe("1.5");
    h.type(h.node("decimal"), "0.5"); h.root.dispatch("change", h.node("decimal"));
    expect(h.requests).toHaveLength(1);
    h.file.config = structuredClone(h.model.baselineFor(h.file));
    expect(h.model.isFileDirty(h.file)).toBe(false);
    expect(modelParameterPresentation(h.model.state, h.file, ["generation"]).parameters
      .find((item: any) => item.key === "top_p").editingText).toBeUndefined();
  });

  test("non-integer and bad-input drafts both block persistence until corrected or cleared", async () => {
    const h = harness(); const input = h.node("number");
    h.type(input, "12"); h.type(input, "12.5"); h.root.dispatch("change", input);
    await expect(h.persistence.saveConfigFile("model", "selected")).resolves.toBe(false);
    expect(input.validationMessage).toContain("integer");
    h.type(input, "", true); h.root.dispatch("change", input);
    await expect(h.persistence.saveConfigFile("model", "selected")).resolves.toBe(false);
    expect(h.saveFile).not.toHaveBeenCalled();
    h.type(input, ""); h.root.dispatch("change", input);
    expect(input.validationMessage).toBe("");
    await expect(h.persistence.saveConfigFile("model", "selected")).resolves.toBe(true);
    expect(h.file.config.generation).toHaveProperty("parameters.max_output_tokens", { mode: "omit" });
  });

  test.each(["modelName", "provider"])("changing %s can discard an unsupported invalid draft without deleting its configured control", async (target) => {
    const h = harness(); h.type(h.node("topP"), "1"); h.type(h.node("topP"), "1.5");
    const control = structuredClone((h.file.config.generation.parameters as any).top_p);
    const identity = h.node(target); identity.value = target === "provider" ? "remote" : "new-target";
    h.root.dispatch("change", identity);
    expect(h.requests).toHaveLength(1);
    await h.settle(0, (presentation) => Object.assign(presentation.model.parameters.find((item: any) => item.key === "top_p"),
      { supported: false, modelSupport: "unsupported" }));
    const presentation = modelParameterPresentation(h.model.state, h.file, ["generation"]);
    const markup = renderModelParameters(h.file, ["generation"], presentation);
    expect(markup).not.toContain('aria-label="Top P value"');
    expect(markup).toContain("Top P input was discarded");
    expect((h.file.config.generation.parameters as any).top_p).toEqual(control);
    await expect(h.persistence.saveConfigFile("model", "selected")).resolves.toBe(true);
  });

  test("changed capabilities retain invalid text with new bounds and keep recommendations blocked", async () => {
    const h = harness(); h.type(h.node("topP"), "1"); h.type(h.node("topP"), "1.5");
    h.type(h.node("modelName"), "stricter-target"); h.root.dispatch("change", h.node("modelName"));
    await h.settle(0, (presentation) => { presentation.model.parameters.find((item: any) => item.key === "top_p").max = 0.5; });
    const presentation = modelParameterPresentation(h.model.state, h.file, ["generation"]);
    const field = presentation.parameters.find((item: any) => item.key === "top_p");
    expect(field).toMatchObject({ editingText: "1.5", editingError: expect.stringContaining("at most 0.5") });
    expect(renderModelParameters(h.file, ["generation"], presentation)).toMatch(/data-config-action="model-parameters-recommended"[^>]+disabled/u);
    await expect(h.persistence.saveConfigFile("model", "selected")).resolves.toBe(false);
    expect(h.saveFile).not.toHaveBeenCalled();
  });

  test("a draft accepted by new capabilities becomes the intended manual value and triggers a new preview", async () => {
    const h = harness();
    h.model.state.configDashboard.modelParameters.selected.model.parameters.find((item: any) => item.key === "top_p").max = 0.5;
    h.type(h.node("topP"), "0.4"); h.type(h.node("topP"), "0.75");
    h.type(h.node("modelName"), "wider-target"); h.root.dispatch("change", h.node("modelName"));
    const widen = (presentation: any) => { presentation.model.parameters.find((item: any) => item.key === "top_p").max = 1; };
    await h.settle(0, widen);
    expect((h.file.config.generation.parameters as any).top_p).toEqual({ mode: "value", value: 0.75 });
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].candidate.models[0].generation.parameters.top_p).toEqual({ mode: "value", value: 0.75 });
    await h.settle(1, widen);
    const presentation = modelParameterPresentation(h.model.state, h.file, ["generation"]);
    expect(presentation.parameters.find((item: any) => item.key === "top_p")).toMatchObject({ source: "manual" });
    await expect(h.persistence.saveConfigFile("model", "selected")).resolves.toBe(true);
  });

  test("editing invalid text while discard confirmation is open invalidates that confirmation", async () => {
    const h = harness(); h.type(h.node("topP"), "1"); h.type(h.node("topP"), "1.5");
    let confirm!: (value: boolean) => void;
    h.confirmDiscard.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
    const discarding = h.prepareDiscardChanges("leave configuration");
    const canonical = JSON.stringify(h.file.config);
    h.type(h.node("topP"), "1.6");
    expect(JSON.stringify(h.file.config)).toBe(canonical);
    confirm(true);
    await expect(discarding).resolves.toBeNull();
    expect(modelParameterPresentation(h.model.state, h.file, ["generation"]).parameters
      .find((field: any) => field.key === "top_p").editingText).toBe("1.6");
  });
});
