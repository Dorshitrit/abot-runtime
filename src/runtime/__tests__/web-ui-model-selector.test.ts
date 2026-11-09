import { describe, expect, test } from "vitest";
import { modelSelectorFixture } from "./support/model-selector-fixture.js";

const models = [
  { value: "ollama-gpt", label: "GPT-OSS 120B", dataset: { providerId: "ollama", providerLabel: "Ollama" } },
  { value: "llama-gpt", label: "GPT-OSS 120B", dataset: { providerId: "llamacpp", providerLabel: "llama.cpp" } },
  { value: "ollama-gemma", label: "Gemma", dataset: { providerId: "ollama", providerLabel: "Ollama" } },
];

describe("Web UI model selector", () => {
  test("starts with providers only while keeping the selected provider and model visible", () => {
    const f = modelSelectorFixture(models, "llama-gpt");
    f.open();
    expect(f.providers().map((provider) => provider.dataset.providerId)).toEqual(["ollama", "llamacpp"]);
    expect(f.providers().every((provider) => provider.getAttribute("role") === "menuitem")).toBe(true);
    expect(f.provider("ollama").textContent).toContain("Ollama");
    expect(f.provider("llamacpp").textContent).toContain("llama.cpp");
    expect(f.items()).toEqual([]);
    expect(f.documentRoot.activeElement).toBe(f.provider("llamacpp"));
    expect(f.valueLabel.querySelector(".model-select-provider")?.textContent).toBe("llama.cpp");
    expect(f.valueLabel.querySelector(".model-select-name")?.textContent).toBe("GPT-OSS 120B");
    expect(f.valueLabel.querySelector(".model-select-separator")?.textContent.trim()).toBe("/");
    expect(f.button.getAttribute("aria-label")).toBe("Model: llama.cpp / GPT-OSS 120B");
    expect(f.button.title).toBe("Model: llama.cpp / GPT-OSS 120B");
    expect(f.select.options.map((option) => option.value)).toEqual(models.map((model) => model.value));
    expect(f.changed).not.toHaveBeenCalled();
  });

  test("browsing one provider, going back, and reopening preserve the selected model", () => {
    const f = modelSelectorFixture(models, "llama-gpt");
    const selectedLabel = f.valueLabel.textContent;
    f.open();
    f.browse("ollama");
    expect(f.providers()).toEqual([]);
    expect(f.items().map((item) => item.dataset.modelId)).toEqual(["ollama-gpt", "ollama-gemma"]);
    expect(f.documentRoot.activeElement).toBe(f.item("ollama-gpt"));
    expect(f.item("ollama-gpt").querySelector(".model-select-option-label")?.textContent).toBe("GPT-OSS 120B");
    expect(f.item("ollama-gpt").getAttribute("aria-checked")).toBe("false");
    expect(f.backButton().getAttribute("role")).toBe("menuitem");
    expect(f.valueLabel.textContent).toBe(selectedLabel);
    f.back();
    expect(f.items()).toEqual([]);
    expect(f.documentRoot.activeElement).toBe(f.provider("ollama"));
    f.browse("ollama");
    f.key("Escape");
    expect(f.menu.hidden).toBe(true);
    expect(f.documentRoot.activeElement).toBe(f.button);
    f.open();
    expect(f.items()).toEqual([]);
    expect(f.documentRoot.activeElement).toBe(f.provider("llamacpp"));
    expect(f.select.value).toBe("llama-gpt");
    expect(f.valueLabel.textContent).toBe(selectedLabel);
    expect(f.changed).not.toHaveBeenCalled();
  });

  test("choosing a duplicate label dispatches the exact profile id once and restores focus", () => {
    const f = modelSelectorFixture(models);
    f.selector.bind();
    f.open();
    expect(f.menu.hidden).toBe(false);
    expect(f.documentRoot.activeElement).toBe(f.provider("ollama"));
    f.browse("llamacpp");
    expect(f.items().map((item) => item.dataset.modelId)).toEqual(["llama-gpt"]);
    expect(f.item("llama-gpt").getAttribute("aria-label")).toBe("llama.cpp / GPT-OSS 120B");
    f.choose("llama-gpt");
    expect(f.select.value).toBe("llama-gpt");
    expect(f.changed).toHaveBeenCalledOnce();
    expect(f.menu.hidden).toBe(true);
    expect(f.button.getAttribute("aria-expanded")).toBe("false");
    expect(f.documentRoot.activeElement).toBe(f.button);
    expect(f.valueLabel.querySelector(".model-select-provider")?.textContent).toBe("llama.cpp");
  });

  test("keyboard navigation skips disabled choices and honors boundaries at both levels", () => {
    const f = modelSelectorFixture([
      models[0],
      { ...models[2], disabled: true },
      { value: "ollama-qwen", label: "Qwen", dataset: models[0].dataset },
      models[1],
      { value: "offline", label: "Offline", disabled: true, dataset: { providerId: "offline", providerLabel: "Offline" } },
      { value: "cloud", label: "Cloud", dataset: { providerId: "openai", providerLabel: "OpenAI" } },
    ]);
    f.open();
    f.key("ArrowDown");
    expect(f.documentRoot.activeElement).toBe(f.provider("llamacpp"));
    expect(f.provider("offline").disabled).toBe(true);
    f.key("ArrowDown");
    expect(f.documentRoot.activeElement).toBe(f.provider("openai"));
    f.key("Home");
    expect(f.documentRoot.activeElement).toBe(f.provider("ollama"));
    f.key("End");
    expect(f.documentRoot.activeElement).toBe(f.provider("openai"));
    f.key("ArrowDown");
    expect(f.documentRoot.activeElement).toBe(f.provider("ollama"));
    f.key("ArrowUp");
    expect(f.documentRoot.activeElement).toBe(f.provider("openai"));
    f.browse("ollama");
    expect(f.documentRoot.activeElement).toBe(f.item("ollama-gpt"));
    expect(f.item("ollama-gemma").disabled).toBe(true);
    f.key("ArrowDown");
    expect(f.documentRoot.activeElement).toBe(f.item("ollama-qwen"));
    f.key("ArrowDown");
    expect(f.documentRoot.activeElement).toBe(f.backButton());
    f.key("End");
    expect(f.documentRoot.activeElement).toBe(f.item("ollama-qwen"));
    f.key("Home");
    expect(f.documentRoot.activeElement).toBe(f.backButton());
    f.key("ArrowDown");
    expect(f.documentRoot.activeElement).toBe(f.item("ollama-gpt"));
    f.key("Escape");
    expect(f.menu.hidden).toBe(true);
    expect(f.documentRoot.activeElement).toBe(f.button);
    expect(f.select.value).toBe("ollama-gpt");
    expect(f.changed).not.toHaveBeenCalled();
  });

  test("native selection changes update provider, selected radio, and ChatGPT plan visibility", () => {
    const f = modelSelectorFixture([
      models[0],
      { value: "chatgpt", label: "GPT", dataset: {
        providerId: "openai-chatgpt", providerLabel: "ChatGPT", authentication: "chatgpt",
      } },
    ]);
    f.select.value = "chatgpt";
    f.select.dispatchEvent(new Event("change"));
    expect(f.valueLabel.querySelector(".model-select-provider")?.textContent).toBe("ChatGPT");
    f.open();
    expect(f.documentRoot.activeElement).toBe(f.provider("openai-chatgpt"));
    f.browse("openai-chatgpt");
    expect(f.item("chatgpt").getAttribute("aria-checked")).toBe("true");
    expect(f.composer.querySelector(".chatgpt-plan-indicator")?.hidden).toBe(false);
    f.select.value = "ollama-gpt";
    f.select.dispatchEvent(new Event("change"));
    expect(f.composer.querySelector(".chatgpt-plan-indicator")?.hidden).toBe(true);
    expect(f.valueLabel.querySelector(".model-select-provider")?.textContent).toBe("Ollama");
  });

  test("options without provider metadata keep the original flat display", () => {
    const f = modelSelectorFixture([{ value: "legacy", label: "My local model" }]);
    expect(f.providers()).toEqual([]);
    expect(f.valueLabel.textContent).toBe("My local model");
    expect(f.valueLabel.querySelector(".model-select-provider")).toBeNull();
    expect(f.button.title).toBe("Model: My local model");
    expect(f.items()).toHaveLength(1);
    f.open();
    f.choose("legacy");
    expect(f.select.value).toBe("legacy");
  });

  test("unlabeled providers remain reachable beside known providers", () => {
    const f = modelSelectorFixture([models[0], { value: "legacy", label: "My local model" }]);
    f.open();
    expect(f.providers()).toHaveLength(2);
    expect(f.provider("").textContent).toContain("Other models");
    f.browse("");
    expect(f.items().map((item) => item.dataset.modelId)).toEqual(["legacy"]);
    f.choose("legacy");
    expect(f.select.value).toBe("legacy");
    expect(f.valueLabel.textContent).toBe("My local model");
  });

  test("an empty or disabled catalog cannot open the picker", () => {
    const empty = modelSelectorFixture([]);
    expect(empty.button.disabled).toBe(true);
    expect(empty.valueLabel.textContent).toBe("No models configured");
    empty.open();
    expect(empty.menu.hidden).toBe(true);
    expect(empty.onOpen).not.toHaveBeenCalled();
    const disabled = modelSelectorFixture(models, "llama-gpt", true);
    expect(disabled.button.disabled).toBe(true);
    disabled.open();
    expect(disabled.menu.hidden).toBe(true);
    expect(disabled.onOpen).not.toHaveBeenCalled();
  });
});
