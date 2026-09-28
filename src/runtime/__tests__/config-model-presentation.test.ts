import { describe, expect, test } from "vitest";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigModelRendering } from "../../web-ui/app/components/config-workspace/model-rendering.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { renderModelSetupEntry } from "../../web-ui/app/components/config-workspace/model-setup-entry.js";

function modelEditor() {
  const { state, configFileKey } = createConfigWorkspaceModel();
  const model = {
    kind: "model",
    id: "local",
    path: "models/local.json",
    registered: true,
    config: {
      provider: "ollama",
      model: "local",
      calibration: { draft: { name: "Draft" } },
    },
  };
  const rendering = createConfigModelRendering({
    state,
    configFileKey,
    calibrationProfileLabel: (step: string) => step,
    configProviderOptions: () => ["ollama"],
    configStepOptions: () => ["draft", "review"],
    getConfigPathValue: () => undefined,
    renderConfigInput: () => "<input>",
    renderConfigTextarea: () => "<textarea></textarea>",
    renderExecutionRoute: () => "",
    renderFileActions: () => "<button data-save>Save</button>",
    renderSelectOptions: () => '<option value="review">Review</option>',
  });
  return { state, render: () => rendering.renderSelectedModelEditor([model]) };
}

describe("Configuration model presentation", () => {
  test("starts the entire calibration section closed while keeping all profile controls mounted", () => {
    const { state, render } = modelEditor();
    let markup = render();
    const section = markup.match(
      /<details\s+class="config-calibration-section"[\s\S]*?>/,
    )?.[0];
    expect(section).toBeDefined();
    expect(section).not.toMatch(/\sopen(?:\s|>)/);
    expect(markup).toContain('data-calibration-key="model:local:draft"');
    expect(markup).toContain('data-config-action="delete-path"');
    expect(markup).toContain('data-config-action="add-calibration"');
    expect(markup).toContain("data-new-calibration-key");
    expect(markup).toContain("<textarea>");
    expect(markup).toContain('data-config-action="remove-model"');
    expect(markup).toContain("data-save");

    state.expandedCalibrationSections.add("model:local");
    state.expandedCalibrationKeys.add("model:local:draft");
    markup = render();
    expect(
      markup.match(
        /<details\s+class="config-calibration-section"[\s\S]*?>/,
      )?.[0],
    ).toMatch(/\sopen(?:\s|>)/);
    expect(
      markup.match(/<details\s+class="config-calibration-card"[\s\S]*?>/)?.[0],
    ).toMatch(/\sopen(?:\s|>)/);
  });

  test("offers one Add model entry and retains provider identity, type, and model counts", () => {
    const runtime = {
      config: {
        models: {
          providers: {
            local: { type: "ollama" },
            cloud: { type: "openai" },
          },
        },
      },
    };
    const markup = renderModelSetupEntry(runtime, [
      { config: { provider: "local" } },
    ]);
    expect(markup.match(/data-config-action="add-model"/g)).toHaveLength(1);
    expect(markup).toContain("<h3>local</h3>");
    expect(markup).toContain("<h3>cloud</h3>");
    expect(markup).toContain("<span>ollama</span>");
    expect(markup).toContain("<span>openai</span>");
    expect(markup).toContain("1 model");
    expect(markup).toContain("0 models");
    expect(
      renderModelSetupEntry(null, []).match(/data-config-action="add-model"/g),
    ).toHaveLength(1);
  });
});
