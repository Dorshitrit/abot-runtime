import { expect, test } from "vitest";
import {
  groupModelSelectorOptions,
  modelSelectorOptions,
} from "../../web-ui/app/lib/model-selector-options.js";

test("identical model names on different providers use provider identity, not profile suffixes", () => {
  const profiles = [
    { id: "oss-ollama", label: "GPT-OSS 120B", provider: "ollama", providerId: "ollama" },
    { id: "oss-llama", label: "GPT-OSS 120B", provider: "llamacpp", providerId: "llamacpp" },
  ];
  const original = structuredClone(profiles);
  expect(modelSelectorOptions(profiles)).toEqual([
    { value: "oss-ollama", label: "GPT-OSS 120B", providerId: "ollama", providerLabel: "Ollama", usingChatgptPlan: false },
    { value: "oss-llama", label: "GPT-OSS 120B", providerId: "llamacpp", providerLabel: "llama.cpp", usingChatgptPlan: false },
  ]);
  expect(profiles).toEqual(original);
});

test("grouping preserves first provider appearance and model order without changing native option order", () => {
  const options = modelSelectorOptions([
    { id: "gemma", provider: "ollama" },
    { id: "cloud", provider: "openai" },
    { id: "oss", provider: "ollama" },
  ]);
  expect(options.map((option) => option.value)).toEqual(["gemma", "cloud", "oss"]);
  expect(groupModelSelectorOptions(options).map((group) => ({
    provider: group.label, ids: group.options.map((option) => option.value),
  }))).toEqual([
    { provider: "Ollama", ids: ["gemma", "oss"] },
    { provider: "OpenAI", ids: ["cloud"] },
  ]);
});

test("multiple connections of the same provider stay visibly distinguishable", () => {
  const options = modelSelectorOptions([
    { id: "local", label: "Gemma", provider: "ollama", providerId: "mac-studio" },
    { id: "remote", label: "Gemma", provider: "ollama", providerId: "server" },
  ]);
  expect(options.map((option) => [option.providerLabel, option.label])).toEqual([
    ["Ollama · mac-studio", "Gemma"], ["Ollama · server", "Gemma"],
  ]);
  expect(groupModelSelectorOptions(options)).toHaveLength(2);
});

test("duplicate labels within the same connection retain saved-profile disambiguation", () => {
  const options = modelSelectorOptions([
    { id: "ea", label: "Qwen", provider: "ollama", providerId: "local" },
    { id: "super", label: "Qwen", provider: "ollama", providerId: "local" },
    { id: "llama", label: "Qwen", provider: "llamacpp" },
  ]);
  expect(options.map((option) => option.label)).toEqual(["Qwen · ea", "Qwen · super", "Qwen"]);
});

test("legacy catalogs and unknown providers do not infer a provider from profile names", () => {
  expect(modelSelectorOptions([{ id: "llama-gpt-oss-120b-2", label: "Custom" }])[0])
    .toMatchObject({ label: "Custom", providerId: "", providerLabel: "" });
  expect(modelSelectorOptions([{ id: "model", provider: "constructor" }])[0])
    .toMatchObject({ providerLabel: "constructor" });
  expect(modelSelectorOptions([{ id: "model", providerId: "private-server" }])[0])
    .toMatchObject({ providerLabel: "private-server" });
  expect(modelSelectorOptions([])).toEqual([]);
});

test("ChatGPT plan metadata remains distinct from OpenAI API and custom labels remain intact", () => {
  const options = modelSelectorOptions([
    { id: "plan", label: " My custom name ", provider: "openai-chatgpt", providerId: "personal" },
    { id: "api", provider: "openai", providerId: "api-key" },
  ]);
  expect(options[0]).toMatchObject({ label: "My custom name", providerLabel: "ChatGPT", usingChatgptPlan: true });
  expect(options[1]).toMatchObject({ label: "api", providerLabel: "OpenAI", usingChatgptPlan: false });
});
