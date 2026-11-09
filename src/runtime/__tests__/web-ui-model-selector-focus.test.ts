import { expect, test } from "vitest";
import { modelSelectorFixture } from "./support/model-selector-fixture.js";

const models = [
  { value: "ollama-gpt", label: "GPT-OSS", dataset: { providerId: "ollama", providerLabel: "Ollama" } },
  { value: "ollama-gemma", label: "Gemma", dataset: { providerId: "ollama", providerLabel: "Ollama" } },
  { value: "llama-gpt", label: "GPT-OSS", dataset: { providerId: "llamacpp", providerLabel: "llama.cpp" } },
];

test.each(["ollama", "llamacpp"])("sync preserves Back focus while browsing %s", (providerId) => {
  const f = modelSelectorFixture(models);
  f.open(); f.browse(providerId); f.key("Home");
  const detached = f.backButton();
  expect(f.documentRoot.activeElement).toBe(detached);
  f.select.options[0].label = "GPT-OSS refreshed";
  f.selector.sync();
  const focused = f.documentRoot.activeElement;
  expect(focused).toBe(f.backButton());
  expect(focused).not.toBe(detached);
  expect(f.menu.contains(detached)).toBe(false);
  expect(f.select.value).toBe("ollama-gpt");
  expect(f.changed).not.toHaveBeenCalled();

  // Native button activation dispatches click to the currently focused action.
  focused?.dispatch("click", { target: focused });
  expect(f.items()).toEqual([]);
  expect(f.documentRoot.activeElement).toBe(f.provider(providerId));
  expect(f.menu.hidden).toBe(false);
  expect(f.select.value).toBe("ollama-gpt");
  expect(f.changed).not.toHaveBeenCalled();
});

test("sync restores the focused unselected model after removing its old DOM node", () => {
  const f = modelSelectorFixture(models);
  f.open(); f.browse("ollama"); f.key("End");
  const detached = f.item("ollama-gemma");
  expect(f.documentRoot.activeElement).toBe(detached);
  f.select.options[1].label = "Gemma refreshed";
  f.selector.sync();
  expect(f.documentRoot.activeElement).toBe(f.item("ollama-gemma"));
  expect(f.documentRoot.activeElement).not.toBe(detached);
  expect(f.menu.contains(detached)).toBe(false);
  expect(f.item("ollama-gemma").textContent).toContain("Gemma refreshed");
  expect(f.select.value).toBe("ollama-gpt");
  expect(f.changed).not.toHaveBeenCalled();
});

test.each(["model", "back"])("removed browsed provider returns from %s focus and stays at providers", (focus) => {
  const f = modelSelectorFixture(models);
  f.open(); f.browse("llamacpp");
  if (focus === "back") f.key("Home");
  f.select.options = f.select.options.filter((option) => option.value !== "llama-gpt");
  f.selector.sync();
  expect(f.items()).toEqual([]);
  expect(f.documentRoot.activeElement).toBe(f.provider("ollama"));
  f.select.options.push(models[2]);
  f.selector.sync();
  expect(f.items()).toEqual([]);
  expect(f.providers()).toHaveLength(2);
  expect(f.documentRoot.activeElement).toBe(f.provider("ollama"));
  expect(f.select.value).toBe("ollama-gpt");
  expect(f.changed).not.toHaveBeenCalled();
});

test.each([false, true])("sync preserves outside focus when open is %s", (open) => {
  const f = modelSelectorFixture(models);
  if (open) { f.open(); f.browse("ollama"); }
  const outside = f.documentRoot.createElement("input");
  f.composer.append(outside); outside.focus();
  f.select.value = "llama-gpt";
  f.selector.sync();
  expect(f.documentRoot.activeElement).toBe(outside);
  expect(f.valueLabel.textContent).toContain("llama.cpp");
  expect(f.menu.hidden).toBe(!open);
});
