import { describe, expect, test, vi } from "vitest";
import { parseModelParameterControls } from "../../shared/model-parameter-validation.js";
// @ts-expect-error Browser module has no declaration surface.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser module has no declaration surface.
import { createModelParameterEdits } from "../../web-ui/app/components/config-workspace/model-parameter-edits.js";
// @ts-expect-error Browser module has no declaration surface.
import { createModelParameterPreview } from "../../web-ui/app/components/config-workspace/model-parameter-preview.js";
// @ts-expect-error Browser module has no declaration surface.
import { renderModelParameters } from "../../web-ui/app/components/config-workspace/model-parameters.js";

function harness(nativeValue: number, recommended?: number) {
  const model = createConfigWorkspaceModel();
  const file = { kind: "model", id: "selected", config: { provider: "local", model: "generic", options: { num_predict: nativeValue }, generation: {} as Record<string, any> } };
  const field: Record<string, any> = { key: "max_output_tokens", label: "Max output tokens", type: "int", min: 1, max: 2147483647,
    value: nativeValue, source: "configuration", supported: true, modelSupport: "unknown", omitted: false, explicit: false,
    warnings: [], description: "Output budget", ...(recommended === undefined ? {} : { recommended }) };
  const presentation = { parameters: [field], warnings: [] };
  model.state.configDashboard = { files: { runtime: { kind: "runtime", id: "runtime", config: { models: { providers: { local: { type: "ollama" } } } } }, models: [file] },
    modelParameters: { selected: { model: presentation, calibration: {} } } };
  model.state.selectedConfigModelId = file.id;
  model.captureBaselines();
  const refreshPreview = vi.fn(); const invalidatePreview = vi.fn();
  const edits = createModelParameterEdits({ ...model, refreshPreview, invalidatePreview, renderConfigDashboard: vi.fn(),
    mutateConfigFile: (_kind: string, _id: string, mutate: (config: unknown) => void) => mutate(file.config) });
  const control = (action: string, value: string) => ({ value, dataset: { configAction: action, id: file.id, generationPath: '["generation"]', parameterKey: field.key } });
  return { ...model, file, field, presentation, edits, control, refreshPreview, invalidatePreview };
}

describe("native output sentinel editing", () => {
  test.each([-1, -2])("opening Custom from native %s waits for a finite user value without saving a sentinel or cap 1", (nativeValue) => {
    const h = harness(nativeValue);
    const before = JSON.stringify(h.file.config);
    h.edits.handle(h.control("model-parameter-mode", "value"));
    expect(JSON.stringify(h.file.config)).toBe(before);
    expect(h.field.editingValue).toBe(true);
    expect(h.invalidatePreview).toHaveBeenCalledOnce();
    expect(h.refreshPreview).not.toHaveBeenCalled();
    const markup = renderModelParameters(h.file, ["generation"], h.presentation);
    expect(markup).toMatch(/value="value" selected[^>]*>Custom/u);
    expect(markup).toMatch(/<input[^>]+aria-label="Max output tokens value"[^>]+value=""/u);
    h.edits.handle(h.control("model-parameter-value", ""));
    expect(JSON.stringify(h.file.config)).toBe(before);
    h.edits.handle(h.control("model-parameter-value", "512"), { commit: false });
    expect(h.file.config.options.num_predict).toBe(nativeValue);
    expect(h.file.config.generation.parameters).toEqual({ max_output_tokens: { mode: "value", value: 512 } });
    expect(parseModelParameterControls(h.file.config.generation.parameters)).toEqual(h.file.config.generation.parameters);
    expect(h.field.editingValue).toBeUndefined();
    h.edits.handle(h.control("model-parameter-value", "512"));
    expect(h.refreshPreview).toHaveBeenCalledOnce();
  });

  test("a valid recommendation can initialize Custom without changing the native option", () => {
    const h = harness(-1, 1024);
    h.edits.handle(h.control("model-parameter-mode", "value"));
    expect(h.file.config.generation.parameters).toEqual({ max_output_tokens: { mode: "value", value: 1024 } });
    expect(h.file.config.options.num_predict).toBe(-1);
    expect(h.field.editingValue).toBeUndefined();
  });

  test("opening an empty Custom draft invalidates a pending preview that could replace that local editing state", async () => {
    const h = harness(-1);
    let resolve!: (value: unknown) => void;
    const preview = createModelParameterPreview({ state: h.state, root: {},
      previewParameters: () => new Promise((done) => { resolve = done; }), renderConfigDashboard: vi.fn() });
    h.invalidatePreview.mockImplementation(preview.invalidate);
    const pending = preview.refresh();
    h.edits.handle(h.control("model-parameter-mode", "value"));
    resolve({ presentation: { model: { parameters: [{ ...h.field, editingValue: undefined }], warnings: [] }, calibration: {} } });
    await pending;
    expect(h.state.configDashboard.modelParameters.selected.model.parameters[0].editingValue).toBe(true);
    expect(h.file.config.generation).toEqual({});
  });

  test("a failed preview leaves editing available and accurately explains unavailable recommendations", async () => {
    const h = harness(-2);
    const preview = createModelParameterPreview({ state: h.state, root: {}, previewParameters: async () => { throw new Error("offline"); }, renderConfigDashboard: vi.fn() });
    await preview.refresh();
    expect(h.presentation).toMatchObject({ pending: false, stale: true });
    expect(h.presentation.warnings).toEqual([expect.objectContaining({ message: expect.stringContaining("You can continue editing") })]);
    h.edits.handle(h.control("model-parameter-value", "128"));
    expect(h.file.config.generation.parameters.max_output_tokens).toEqual({ mode: "value", value: 128 });
  });
});
