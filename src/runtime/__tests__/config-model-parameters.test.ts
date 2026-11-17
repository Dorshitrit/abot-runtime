import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { renderModelParameters } from "../../web-ui/app/components/config-workspace/model-parameters.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createModelParameterEdits } from "../../web-ui/app/components/config-workspace/model-parameter-edits.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createModelParameterPreview } from "../../web-ui/app/components/config-workspace/model-parameter-preview.js";

function field(key: string, extra = {}) {
  return { key, label: key, group: "sampling", type: "number", supported: true, modelSupport: "supported", explicit: false,
    omitted: true, source: "server", description: "Sampling control", warnings: [], ...extra };
}

function harness() {
  const model = createConfigWorkspaceModel();
  const file = { kind: "model", id: "selected", config: { provider: "local", model: "generic", generation: {
    temperature: 0.2, reasoningBudget: { mode: "server-default" }, reasoningBudgetByMode: { fast: 0 },
  } } };
  model.state.configDashboard = { files: { runtime: { kind: "runtime", id: "runtime", config: { models: { providers: { local: { type: "llamacpp", apiKeyEnv: "PRIVATE" } } } } }, models: [file] },
    modelParameters: { selected: { model: { parameters: [
      field("temperature", { legacyKeys: ["temperature"], recommended: 1, value: 0.2, configuredValue: 0.2, explicit: true, source: "configuration" }),
      field("top_k", { type: "int", recommended: 0 }),
      field("seed", { type: "int", advanced: true }),
      field("thinking_budget", { group: "reasoning", type: "int", legacyKeys: ["reasoningBudget"] }),
      field("unsupported", { supported: false, recommended: 99 }),
    ], warnings: [], notes: "Example note" }, calibration: {} } } };
  model.state.selectedConfigModelId = file.id;
  model.captureBaselines();
  const refreshPreview = vi.fn();
  const edits = createModelParameterEdits({ ...model, mutateConfigFile: (_kind: string, _id: string, mutate: (config: unknown) => void) => mutate(file.config), refreshPreview, renderConfigDashboard: vi.fn() });
  return { ...model, file, edits, refreshPreview };
}

function control(action: string, key: string, value = "") {
  return { value, dataset: { configAction: action, id: "selected", generationPath: '["generation"]', parameterKey: key } };
}

describe("generic model parameter editor", () => {
  test("shows supported fields, saved sources, advanced controls, notes and recommended placeholders", () => {
    const { state, file } = harness();
    const markup = renderModelParameters(file, ["generation"], state.configDashboard.modelParameters.selected.model);
    expect(markup).toContain('placeholder="Recommended: 1"');
    expect(markup).toContain("Saved config");
    expect(markup).toContain("Advanced");
    expect(markup).toContain("Example note");
    expect(markup).toContain('data-parameter-key="seed"');
    expect(markup).not.toContain('data-parameter-key="unsupported"');
  });

  test("Apply recommended changes only supported recommended controls and retains unrelated settings", () => {
    const { file, edits } = harness();
    edits.handle(control("model-parameters-recommended", ""));
    expect(file.config.generation).toEqual({ reasoningBudget: { mode: "server-default" }, reasoningBudgetByMode: { fast: 0 }, parameters: {
      temperature: { mode: "value", value: 1 }, top_k: { mode: "value", value: 0 },
    } });
  });

  test("groups controls using metadata and keeps contextual fields and overrides in their sections", () => {
    const { state, file } = harness();
    const markup = renderModelParameters(file, ["generation"], state.configDashboard.modelParameters.selected.model, {
      reasoningFields: '<label data-context-window>Context window<input></label>',
      advancedFields: '<label data-mode-overrides>Mode token overrides<select></select></label>',
    });
    const sampling = markup.match(/<section[^>]*aria-label="Sampling"[\s\S]*?<\/section>/)?.[0];
    const reasoning = markup.match(/<section[^>]*aria-label="Reasoning &amp; limits"[\s\S]*?<\/section>/)?.[0];
    const advanced = markup.slice(markup.indexOf('<details class="config-model-parameter-advanced"'));
    expect(sampling).toContain('data-parameter-key="temperature"');
    expect(sampling).not.toContain('data-parameter-key="thinking_budget"');
    expect(reasoning).toContain('data-parameter-key="thinking_budget"');
    expect(reasoning).toContain("data-context-window");
    expect(advanced).toContain('data-parameter-key="seed"');
    expect(advanced).toContain("data-mode-overrides");
    expect(advanced).not.toMatch(/^<details[^>]*\bopen\b/);
    expect(markup).toMatch(/<details class="config-model-parameter-notes"><summary>Model notes<\/summary>/);
  });

  test("keeps descriptions in accessible disclosures and compatibility warnings visible", () => {
    const { state, file } = harness();
    const metadata = state.configDashboard.modelParameters.selected.model;
    metadata.parameters = [field("sample", { note: "Conditional support.", warnings: [{ message: "Saved value is mapped." }] })];
    const markup = renderModelParameters(file, ["generation"], metadata);
    expect(markup).toMatch(/<summary aria-label="About sample">[\s\S]*?Sampling control[\s\S]*?Conditional support\.[\s\S]*?<\/details>/);
    expect(markup).toMatch(/<\/details>[\s\S]*?<p class="config-model-parameter-warning" role="status">Saved value is mapped\.<\/p>/);
    expect(markup).toContain('aria-label="sample mode"');
    expect(markup).toContain('aria-label="sample value"');
    expect(markup).not.toContain("Existing behavior");
    expect(markup).not.toContain("Explicit value");
  });

  test.each(["pending", "stale"])("%s metadata disables recommendations while controls remain editable", (status) => {
    const { state, file } = harness();
    const markup = renderModelParameters(file, ["generation"], { ...state.configDashboard.modelParameters.selected.model, [status]: true });
    expect(markup).toMatch(/<button[^>]*data-config-action="model-parameters-recommended"[^>]*\bdisabled\b/);
    expect(markup).not.toMatch(/<(?:fieldset|input|select)[^>]*\bdisabled\b/);
    expect(markup).toContain('value="0.2"');
  });

  test("an empty custom draft does not present a native output sentinel as a canonical value", () => {
    const { state, file } = harness();
    const metadata = state.configDashboard.modelParameters.selected.model;
    metadata.parameters = [field("max_output_tokens", { group: "reasoning", source: "configuration", value: -1, editingValue: true })];
    const markup = renderModelParameters(file, ["generation"], metadata);
    expect(markup).toContain('<option value="value" selected>Custom</option>');
    expect(markup).toMatch(/<input[^>]*value=""/);
    expect(markup).not.toContain('value="-1"');
    expect(markup).toContain("Saved config");
  });

  test("identifies unknown model support and runtime-derived defaults without pre-filling recommendations", () => {
    const { state, file } = harness();
    const metadata = state.configDashboard.modelParameters.selected.model;
    metadata.parameters = [field("max_output_tokens", { modelSupport: "unknown", source: "provider", recommended: 32, note: "Calculated for each run." })];
    const markup = renderModelParameters(file, ["generation"], metadata);
    expect(markup).toContain("Model-specific support is unverified");
    expect(markup).toContain("Provider/runtime default");
    expect(markup).toContain("Calculated for each run.");
    expect(markup).toContain('value="" placeholder="Recommended: 32"');
    expect(file.config.generation).not.toHaveProperty("parameters");
  });

  test("empty values persist explicit omission and budget edits remove only their own alias", () => {
    const { file, edits } = harness();
    edits.handle(control("model-parameter-value", "temperature", ""));
    edits.handle(control("model-parameter-mode", "thinking_budget", "omit"));
    expect(file.config.generation).toEqual({ reasoningBudgetByMode: { fast: 0 }, parameters: { temperature: { mode: "omit" }, thinking_budget: { mode: "omit" } } });
    edits.handle(control("model-parameter-mode", "temperature", "inherit"));
    expect((file.config.generation as any).parameters.temperature).toEqual({ mode: "inherit" });
  });

  test("a pending capability refresh cannot apply stale recommendations", () => {
    const { state, file, edits } = harness();
    const before = JSON.stringify(file.config);
    state.configDashboard.modelParameters.selected.model.pending = true;
    edits.handle(control("model-parameters-recommended", ""));
    expect(JSON.stringify(file.config)).toBe(before);
  });

  test("discards out-of-order previews and never sends provider credentials or file paths", async () => {
    const { state, file } = harness();
    const pending: Array<(value: unknown) => void> = [];
    const previewParameters = vi.fn((_candidate: Record<string, unknown>) => new Promise((resolve) => pending.push(resolve)));
    const preview = createModelParameterPreview({ state, root: {}, previewParameters, renderConfigDashboard: vi.fn() });
    const first = preview.refresh();
    file.config.model = "new-target";
    const second = preview.refresh();
    const latest = { model: { parameters: [], warnings: [], profileId: "new" }, calibration: {} };
    pending[1]({ presentation: latest }); await second;
    pending[0]({ presentation: { ...latest, model: { ...latest.model, profileId: "old" } } }); await first;
    expect(state.configDashboard.modelParameters.selected.model.profileId).toBe("new");
    expect(previewParameters.mock.calls[0][0]).toMatchObject({ providers: { local: { type: "llamacpp" } } });
    expect(JSON.stringify(previewParameters.mock.calls)).not.toContain("PRIVATE");
    expect(JSON.stringify(previewParameters.mock.calls)).not.toContain("configPath");
  });
});
