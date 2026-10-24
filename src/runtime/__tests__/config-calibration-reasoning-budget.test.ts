import { describe, expect, test } from "vitest";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigWorkspaceModel } from "../../web-ui/app/components/config-workspace/config-model.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { createConfigModelRendering } from "../../web-ui/app/components/config-workspace/model-rendering.js";
import { parseReasoningBudgetMode } from "../../web-ui/app/components/config-workspace/reasoning-budget.js";

function editor(sourceType: string, targetType: string, budget?: { mode: string; tokens?: number }) {
  const { state, configFileKey } = createConfigWorkspaceModel();
  const calibration: { profileId?: string; generation?: { reasoningBudget: typeof budget } } = {
    profileId: "target",
    ...(budget ? { generation: { reasoningBudget: budget } } : {}),
  };
  const source = {
    kind: "model", id: "source", registered: true, path: "models/source.json",
    config: { provider: "source-provider", model: "source", supportsThinking: true as boolean | undefined, calibration: { draft: calibration } },
  };
  const target = {
    kind: "model", id: "target", registered: true, path: "models/target.json",
    config: { provider: "target-provider", model: "target", supportsThinking: true as boolean | undefined },
  };
  state.configDashboard = { files: {
    runtime: { config: { models: { providers: {
      "source-provider": { type: sourceType }, "target-provider": { type: targetType },
    } } } }, models: [source, target],
  } };
  const rendering = createConfigModelRendering({
    state, configFileKey,
    calibrationProfileLabel: (step: string) => step,
    configProviderOptions: () => ["source-provider", "target-provider"],
    configStepOptions: () => ["draft"], getConfigPathValue: () => undefined,
    renderConfigInput: () => "<input>", renderConfigTextarea: () => "<textarea></textarea>",
    renderExecutionRoute: () => "", renderFileActions: () => "", renderSelectOptions: () => "",
  });
  return { calibration, source, target, render: () => {
    const markup: string = rendering.renderSelectedModelEditor([source, target]);
    return markup.match(/<details\s+class="config-calibration-card"[\s\S]*?<\/details>/)?.[0] || "";
  } };
}

describe("configuration calibration reasoning budgets", () => {
  test.each(["ollama", "openai"])("offers a budget for %s calibration routed to llama.cpp", (source) => {
    const h = editor(source, "llamacpp");
    expect(h.render()).toContain('value="tokens"');
    expect(h.render()).toContain('value="server-default"');
    // The dashboard reflects current edits, including a target provider change.
    h.target.config.provider = "source-provider";
    expect(h.render()).not.toContain("Thinking budget");
  });

  test.each(["ollama", "openai"])("hides new budgets for llama.cpp calibration routed to %s", (target) => {
    const h = editor("llamacpp", target);
    expect(h.render()).not.toContain("Thinking budget");
    delete h.calibration.profileId;
    expect(h.render()).toContain('value="tokens"');
  });

  test.each([false, undefined])("requires declared thinking support on the target: %s", (supportsThinking) => {
    const h = editor("llamacpp", "llamacpp");
    h.target.config.supportsThinking = supportsThinking;
    expect(h.render()).not.toContain("Thinking budget");
    h.target.config.supportsThinking = true;
    h.source.config.supportsThinking = supportsThinking;
    expect(h.render()).toContain('value="tokens"');
    delete h.calibration.profileId;
    expect(h.render()).not.toContain("Thinking budget");
  });

  test("keeps a saved budget removable when target thinking support is disabled", () => {
    const h = editor("llamacpp", "llamacpp", { mode: "tokens", tokens: 256 });
    h.target.config.supportsThinking = false;
    expect(h.render()).toContain('value="tokens" selected disabled');
    expect(h.render()).toContain("Choose Inherit to remove this override");
    expect(h.render()).not.toContain("Thinking tokens");
  });

  test("retains an unsupported saved budget only so it can be cleared", () => {
    const budget = { mode: "tokens", tokens: 256 };
    const h = editor("llamacpp", "openai", budget);
    const markup = h.render();
    expect(markup).toContain("Choose Inherit to remove this override");
    expect(markup).toContain('value="inherit"');
    expect(markup).toContain('value="tokens" selected disabled');
    expect(markup).not.toContain("Thinking tokens");
    expect(markup).not.toContain('value="server-default"');
    expect(parseReasoningBudgetMode("inherit", budget)).toBeUndefined();
  });

  test("does not fall back to the source when the calibration target is missing", () => {
    const h = editor("llamacpp", "llamacpp");
    h.calibration.profileId = "missing";
    expect(h.render()).not.toContain("Thinking budget");
  });

  test("explains that the answer shares the total output limit", () => {
    const h = editor("ollama", "llamacpp", { mode: "tokens", tokens: 256 });
    expect(h.render()).toContain("The answer also needs capacity within the total output limit");
    expect(h.render()).not.toContain("separate output allowance");
  });
});
