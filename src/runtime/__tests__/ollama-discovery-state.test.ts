import { expect, test, vi } from "vitest";
import { createModelWizardHarness } from "./support/model-setup-wizard-harness.js";
import { createGuideHarness } from "./support/runtime-setup-guide-harness.js";

function deferredCatalog() {
  let resolve!: (value: { connection: { models: string[] } }) => void;
  const promise = new Promise<{ connection: { models: string[] } }>((done) => { resolve = done; });
  return { promise, resolve };
}

test("model wizard drops a delayed old-address catalog and saves the latest visible model and address", async () => {
  const pending = deferredCatalog();
  const inspectConnection = vi.fn(() => pending.promise);
  const h = createModelWizardHarness({ inspectConnection });
  await h.wizard.open();
  h.choose("new:ollama");
  h.click("next");
  h.input("model-id", "old-model");
  h.input("ollama-base-url", "http://old.invalid:11434");
  h.click("inspect-model-connection");
  expect(inspectConnection).toHaveBeenCalledWith({ provider: "ollama", baseUrl: "http://old.invalid:11434" });
  h.input("model-id", "latest-model");
  h.input("ollama-base-url", "http://latest.invalid:11434");
  pending.resolve({ connection: { models: ["old-only"] } });
  await Promise.resolve();
  await Promise.resolve();
  expect(h.dialog.querySelector("[data-connection-models]")).toBeNull();
  expect(h.dialog.textContent).not.toContain("old-only");
  h.click("next");
  h.click("finish");
  await h.settled();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({ model: "latest-model", newProvider: { baseUrl: "http://latest.invalid:11434" } });
  h.wizard.dispose();
});

test("first-install guide drops stale discovery and saves edits entered during the metadata request", async () => {
  const pending = deferredCatalog();
  const inspectConnection = vi.fn(() => pending.promise);
  const h = createGuideHarness({ inspectConnection });
  await h.open();
  h.changeProvider("ollama");
  h.submit();
  h.inputModel("old-model");
  h.inputBaseUrl("http://old.invalid:11434");
  h.click("inspect-model-connection");
  expect(inspectConnection).toHaveBeenCalledOnce();
  h.inputModel("latest-model");
  h.inputBaseUrl("http://latest.invalid:11434");
  pending.resolve({ connection: { models: ["old-only"] } });
  await Promise.resolve();
  await Promise.resolve();
  h.submit();
  await vi.waitFor(() => expect(h.submissions).toHaveLength(1));
  expect(h.submissions[0]).toMatchObject({ model: "latest-model", baseUrl: "http://latest.invalid:11434" });
  expect(h.container.innerHTML).not.toContain("old-only");
  h.guide.dispose();
});

test("a discovered catalog warns on typos, accepts implicit latest tags, and never blocks offline saves", async () => {
  const inspectConnection = vi.fn(async () => ({ connection: { models: ["qwen:latest"] } }));
  const h = createModelWizardHarness({ inspectConnection });
  await h.wizard.open({ providerId: "local" });
  h.input("model-id", "qwen");
  h.click("inspect-model-connection");
  await vi.waitFor(() => expect(h.dialog.querySelector("[data-connection-models]")).not.toBeNull());
  const feedback = () => h.dialog.querySelector("[data-connection-inspection-message]")!.textContent;
  expect(feedback()).not.toContain("was not found");
  h.input("model-id", "qwen-typo:9b");
  expect(feedback()).toContain("Model 'qwen-typo:9b' was not found");
  expect(feedback()).toContain("You can still save settings");
  h.input("model-id", "qwen:latest");
  expect(feedback()).not.toContain("was not found");
  h.input("model-id", "future-offline-model");
  h.click("next");
  h.click("finish");
  await h.settled();
  expect(h.requests[0]).toMatchObject({ model: "future-offline-model" });
  expect(inspectConnection).toHaveBeenCalledOnce();
  h.wizard.dispose();
});

test("editing only the model during discovery evaluates the latest model against the completed catalog", async () => {
  const pending = deferredCatalog();
  const h = createModelWizardHarness({ inspectConnection: () => pending.promise });
  await h.wizard.open({ providerId: "local" });
  h.input("model-id", "installed");
  h.click("inspect-model-connection");
  h.input("model-id", "not-installed");
  pending.resolve({ connection: { models: ["installed:latest"] } });
  await vi.waitFor(() => expect(h.dialog.querySelector("[data-connection-inspection-message]")!.textContent).toContain("Model 'not-installed' was not found"));
  expect(h.field("model-id")?.value).toBe("not-installed");
  h.wizard.dispose();
});
