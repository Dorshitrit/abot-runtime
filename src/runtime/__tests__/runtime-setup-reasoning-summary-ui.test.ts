import { expect, test } from "vitest";
import { createGuideHarness, setupSnapshot } from "./support/runtime-setup-guide-harness.js";
import { setupReasoningSummaryInput, setupReasoningSummaryState, updateSetupReasoningSummaryField } from "../../web-ui/app/components/runtime-setup/reasoning-summary-fields.js";
import type { RuntimeSetupSnapshot } from "../../web-ui/app/components/runtime-setup-guide.js";

function savedSetup(summary?: "auto" | "concise" | "detailed" | null): RuntimeSetupSnapshot {
  return { ...setupSnapshot, status: "ready", configExists: true,
    editableConnection: { revision: "saved-revision" },
    providers: setupSnapshot.providers.map((provider) => ({ ...provider, credentialConfigured: true })),
    existingModel: { provider: "openai", model: "saved-model", contextWindowTokens: 32768,
      ...(summary !== undefined ? { reasoningSummary: summary } : {}) },
  };
}

test.each([null, "auto", "concise", "detailed"])("first setup submits %s only on Save and shows it in Ready review", async (summary) => {
  const h = createGuideHarness();
  await h.open();
  h.changeProvider("openai"); h.submit();
  expect(h.container.innerHTML).toContain('data-runtime-setup-field="reasoning-summary"');
  expect(h.container.innerHTML).toContain('<option value="" selected>Off</option>');
  h.inputModel("summary-model"); h.inputKey("fixture-key");
  if (summary !== null) h.inputReasoningSummary(summary);
  expect(h.saveSetup).not.toHaveBeenCalled();
  h.submit(); await h.ready();
  expect(h.submissions).toHaveLength(1);
  expect(h.submissions[0]).toMatchObject({ provider: "openai", reasoningSummary: summary, deferActivation: true });
  await h.skipToReview(); await h.ready();
  expect(h.container.innerHTML).toContain("<dt>Reasoning summary</dt>");
});

test.each([undefined, null, "auto", "concise", "detailed"] as const)("connection editing preserves restored %s when changing another field", async (summary) => {
  const h = createGuideHarness({ loadSetup: async () => ({ setup: savedSetup(summary) }) });
  await h.open();
  expect(h.container.innerHTML).toContain(`<option value="${summary ?? ""}" selected>`);
  h.inputModel("corrected-model");
  h.submit(); await h.ready();
  if (summary === undefined) expect(h.submissions[0]).not.toHaveProperty("reasoningSummary");
  else expect(h.submissions[0]).toMatchObject({ reasoningSummary: summary });
});

test("a summary-only edit changes Continue to Save and explicit Off clears the saved preference", async () => {
  const h = createGuideHarness({ loadSetup: async () => ({ setup: savedSetup("auto") }) });
  await h.open();
  h.inputReasoningSummary("");
  expect(h.submitAction.textContent).toBe("Save connection");
  h.submit(); await h.ready();
  expect(h.submissions[0]).toMatchObject({ model: "saved-model", reasoningSummary: null, connectionRevision: "saved-revision" });
});

test("provider switching retains the summary draft but local saves omit it", async () => {
  const h = createGuideHarness();
  await h.open();
  h.changeProvider("openai"); h.submit();
  h.inputReasoningSummary("detailed");
  h.click("back"); h.changeProvider("ollama"); h.submit();
  expect(h.container.innerHTML).not.toContain('data-runtime-setup-field="reasoning-summary"');
  h.click("back"); h.changeProvider("openai"); h.submit();
  expect(h.container.innerHTML).toContain('<option value="detailed" selected>');
  h.click("back"); h.changeProvider("ollama"); h.submit();
  h.inputModel("local-model");
  h.submit(); await h.ready();
  expect(h.submissions[0]).toMatchObject({ provider: "ollama" });
  expect(h.submissions[0]).not.toHaveProperty("reasoningSummary");
});

test("128 first-setup draft edits cause no request before the explicit save", async () => {
  const h = createGuideHarness();
  await h.open(); h.changeProvider("openai"); h.submit();
  h.inputModel("burst-model"); h.inputKey("fixture-key");
  for (let index = 0; index < 128; index += 1) h.inputReasoningSummary(index % 2 ? "detailed" : "auto");
  expect(h.saveSetup).not.toHaveBeenCalled();
  h.submit(); await h.ready();
  expect(h.submissions).toHaveLength(1);
  expect(h.submissions[0]).toMatchObject({ reasoningSummary: "detailed" });
});

test.each([undefined, "future-value", false, { unknown: true }])("an omitted or unknown restored %j never becomes an implicit clearing request", (summary) => {
  const state = setupReasoningSummaryState({ reasoningSummary: summary });
  expect(setupReasoningSummaryInput("openai", state.reasoningSummary)).toEqual({});
  expect(state.reasoningSummary).toEqual(summary);
  updateSetupReasoningSummaryField(state, "reasoning-summary", "");
  expect(setupReasoningSummaryInput("openai", state.reasoningSummary)).toEqual({ reasoningSummary: null });
  expect(setupReasoningSummaryInput("openai-chatgpt", state.reasoningSummary)).toEqual({});
});
