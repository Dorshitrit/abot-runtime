import { expect, test, vi } from "vitest";
import { createModelWizardHarness } from "./support/model-setup-wizard-harness.js";

test("Ollama setup discovers IDs on demand and offers them without saving or choosing a model", async () => {
  const inspectConnection = vi.fn(async () => ({ connection: { models: ["qwen:3b", "gemma:latest"] } }));
  const harness = createModelWizardHarness({ inspectConnection });
  await harness.wizard.open({ providerId: "local" });
  expect(harness.dialog.innerHTML).toContain("Discover models");
  harness.input("model-id", "typed-model");
  harness.click("inspect-model-connection");
  await vi.waitFor(() => expect(harness.dialog.querySelector("[data-connection-models]")?.querySelectorAll("option")).toHaveLength(2));
  expect(inspectConnection).toHaveBeenCalledWith({ providerId: "local" });
  expect(harness.field("model-id")?.value).toBe("typed-model");
  expect(harness.field("model-id")?.getAttribute("list")).toBeTruthy();
  expect(harness.requests).toEqual([]);
  harness.wizard.dispose();
});

test("new Ollama connection inspection sends the selected provider and invalidates choices on address edits", async () => {
  const inspectConnection = vi.fn(async () => ({ connection: { models: ["qwen:3b"] } }));
  const harness = createModelWizardHarness({ inspectConnection });
  await harness.wizard.open();
  harness.choose("new:ollama");
  harness.click("next");
  harness.input("ollama-base-url", "http://fixture.invalid:11434");
  harness.click("inspect-model-connection");
  await vi.waitFor(() => expect(harness.field("model-id")?.hasAttribute("list")).toBe(true));
  expect(inspectConnection).toHaveBeenCalledWith({ provider: "ollama", baseUrl: "http://fixture.invalid:11434" });
  harness.input("ollama-base-url", "http://other.invalid:11434");
  expect(harness.field("model-id")?.hasAttribute("list")).toBe(false);
  expect(harness.dialog.querySelector("[data-connection-models]")).toBeNull();
  harness.wizard.dispose();
});
