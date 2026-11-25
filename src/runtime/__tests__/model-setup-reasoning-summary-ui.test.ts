import { expect, test, vi } from "vitest";
import { createModelWizardHarness, modelSetupCatalog } from "./support/model-setup-wizard-harness.js";

test.each([null, "auto", "concise", "detailed"])("Add Model carries %s through review, Back and final Save", async (summary) => {
  const h = createModelWizardHarness();
  await h.wizard.open({ providerId: "cloud" });
  const select = h.field("reasoning-summary")!;
  expect(select).not.toBeNull();
  expect(select.innerHTML).toContain('value="" selected=""');
  h.input("model-id", "summary-model");
  if (summary !== null) h.input("reasoning-summary", summary);
  h.click("next");
  expect(h.dialog.textContent).toContain("Reasoning summary");
  expect(h.dependencies.saveModel).not.toHaveBeenCalled();
  h.click("back");
  expect(h.field("reasoning-summary")).toBe(select);
  h.click("next");
  h.click("finish");
  await h.settled();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({ providerId: "cloud", reasoningSummary: summary });
  expect(h.dependencies.applySetup).toHaveBeenCalledOnce();
});

test("128 summary draft changes retain the form and cause no save before Finish", async () => {
  const h = createModelWizardHarness();
  await h.wizard.open({ providerId: "cloud" });
  const form = h.dialog.querySelector("[data-model-form]");
  const choices = ["auto", "concise", "detailed", ""];
  h.input("model-id", "summary-burst");
  for (let index = 0; index < 128; index += 1) h.input("reasoning-summary", choices[index % 4]!);
  expect(h.dialog.querySelector("[data-model-form]")).toBe(form);
  expect(h.dependencies.saveModel).not.toHaveBeenCalled();
  expect(h.dependencies.applySetup).not.toHaveBeenCalled();
  h.click("next");
  expect(h.dependencies.saveModel).not.toHaveBeenCalled();
  h.click("finish");
  await h.settled();
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({ reasoningSummary: null });
});

test("a new OpenAI connection submits the summary as a model option beside the connection", async () => {
  const h = createModelWizardHarness();
  await h.wizard.open();
  h.choose("new:openai"); h.click("next");
  h.input("model-id", "new-cloud-model"); h.input("api-key", "fixture-key");
  h.input("reasoning-summary", "auto");
  h.click("next"); h.click("finish");
  await h.settled();
  expect(h.requests[0]).toMatchObject({ reasoningSummary: "auto", newProvider: { type: "openai" } });
  expect(h.requests[0].newProvider).not.toHaveProperty("reasoningSummary");
});

test.each(["ollama", "llamacpp", "openai-chatgpt"])("an existing %s connection never exposes the summary field even under an openai alias", async (type) => {
  const h = createModelWizardHarness({ loadSetup: async () => ({ ...modelSetupCatalog,
    providers: [{ id: "openai", type, label: "Test connection", requiresApiKey: false, credentialConfigured: true }],
  }) });
  await h.wizard.open({ providerId: "openai" });
  expect(h.field("reasoning-summary")).toBeNull();
});

test("provider navigation retains the draft choice but excludes it from local requests", async () => {
  const h = createModelWizardHarness();
  await h.wizard.open({ providerId: "cloud" });
  h.input("reasoning-summary", "detailed");
  h.click("back");
  h.choose("existing:local");
  h.click("next");
  expect(h.field("reasoning-summary")).toBeNull();
  h.click("back");
  h.choose("existing:cloud");
  h.click("next");
  expect(h.field("reasoning-summary")!.innerHTML).toContain('value="detailed" selected=""');
  h.click("back");
  h.choose("existing:local");
  h.click("next");
  h.input("model-id", "local-model");
  h.click("next");
  h.click("finish");
  await h.settled();
  expect(h.requests[0]).not.toHaveProperty("reasoningSummary");
});

test("an apply retry uses the saved summary without resubmitting the model", async () => {
  const applySetup = vi.fn().mockResolvedValueOnce({ activation: { status: "restart_required" } })
    .mockResolvedValueOnce({ activation: { status: "ready" } });
  const h = createModelWizardHarness({ applySetup });
  await h.wizard.open({ providerId: "cloud" });
  h.input("model-id", "retry-summary");
  h.input("reasoning-summary", "concise");
  h.click("next"); h.click("finish");
  await h.settled();
  expect(h.requests).toHaveLength(1);
  expect(h.dialog.textContent).toContain("Concise");
  h.click("finish");
  await h.settled();
  expect(h.requests).toHaveLength(1);
  expect(applySetup).toHaveBeenCalledTimes(2);
});
