import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { createModelWizardHarness, modelSetupCatalog } from "./support/model-setup-wizard-harness.js";
import { renderConnectionFields } from "../../web-ui/app/components/runtime-setup/connection-form.js";
import { renderSetupReasoningFields, setupReasoningState, validateSetupReasoningFields } from "../../web-ui/app/components/runtime-setup/reasoning-fields.js";
import { renderReasoningBudget, parseReasoningBudgetMode } from "../../web-ui/app/components/config-workspace/reasoning-budget.js";

describe("thinking controls during registration", () => {
  test("a saved zero budget remains visible when reopening setup", () => {
    const state = { provider: "llamacpp", ...setupReasoningState({
      supportsThinking: true, reasoningBudget: { mode: "tokens", tokens: 0 },
    }) };
    expect(state.reasoningBudgetTokens).toBe("0");
    expect(renderSetupReasoningFields(state)).toContain('data-runtime-setup-field="reasoning-budget-tokens" value="0"');
  });
  test.each(["openai", "ollama", "llamacpp"])("renders a compact capability control for %s and gates numeric controls", (provider) => {
    const markup = renderConnectionFields({
      providers: [{ id: provider, credentialConfigured: true }], provider,
      modelId: "test", contextWindowTokens: 32768, baseUrl: "http://localhost:8080",
      supportsThinking: true, reasoningBudgetMode: "tokens", reasoningBudgetTokens: "512",
    });
    expect(markup).toContain('class="runtime-setup-field runtime-setup-reasoning-toggle"');
    expect(markup).toContain('data-runtime-setup-field="supports-thinking"');
    expect(markup.includes('data-runtime-setup-field="reasoning-budget-tokens"')).toBe(provider === "llamacpp");
  });

  test("checkbox layout has an explicit small size overriding the full-width field style", async () => {
    const css = await readFile("src/web-ui/app/styles/19-runtime-setup.css", "utf8");
    const scoped = css.slice(css.indexOf('.runtime-setup-field.runtime-setup-reasoning-toggle input[type="checkbox"]'));
    expect(scoped).toMatch(/width: 1rem/);
    expect(scoped).toMatch(/height: 1rem/);
    expect(css).toMatch(/\.runtime-setup-reasoning-toggle-label\s*\{\s*display: flex/);
  });

  test.each(["openai", "ollama", "llamacpp"])("saves true and explicit false for a new %s model", async (provider) => {
    for (const enabled of [true, false]) {
      const h = createModelWizardHarness();
      await h.wizard.open();
      h.choose("new:" + provider);
      h.click("next");
      h.input("model-id", "reasoning-model");
      const checkbox = h.field("supports-thinking") as any;
      checkbox.checked = enabled;
      h.input("supports-thinking", "");
      if (provider === "openai") h.input("api-key", "synthetic-openai-key");
      h.click("next");
      h.click("finish");
      await h.settled();
      expect(h.requests[0]).toMatchObject({ supportsThinking: enabled, newProvider: { type: provider } });
      expect(h.requests[0]).not.toHaveProperty("reasoningBudget");
    }
  });

  test.each(["openai", "ollama", "llamacpp"])("exposes thinking support when reusing a saved %s connection", async (provider) => {
    const h = createModelWizardHarness({
      loadSetup: async () => ({
        ...modelSetupCatalog,
        providers: [{ id: "saved", type: provider, label: "Saved", requiresApiKey: provider === "openai", credentialConfigured: provider === "openai" }],
      }),
    });
    await h.wizard.open({ providerId: "saved" });
    h.input("model-id", "reasoning-model");
    (h.field("supports-thinking") as any).checked = true;
    h.input("supports-thinking", "");
    h.click("next");
    h.click("finish");
    await h.settled();
    expect(h.requests[0]).toMatchObject({ supportsThinking: true, providerId: "saved" });
  });

  test("numeric budget is validated and preserved through review and save with private optional auth", async () => {
    const h = createModelWizardHarness();
    await h.wizard.open();
    h.choose("new:llamacpp");
    h.click("next");
    h.input("model-id", "gemma");
    h.input("api-key", "synthetic-local-key");
    (h.field("supports-thinking") as any).checked = true;
    h.input("supports-thinking", "");
    expect(h.field("api-key")?.value).toBe("synthetic-local-key");
    h.input("reasoning-budget-mode", "tokens");
    h.input("reasoning-budget-tokens", "-1");
    h.click("next");
    expect(h.dependencies.saveModel).not.toHaveBeenCalled();
    h.input("reasoning-budget-tokens", "256");
    h.click("next");
    h.click("finish");
    await h.settled();
    expect(h.requests[0]).toMatchObject({
      supportsThinking: true, reasoningBudget: { mode: "tokens", tokens: 256 },
      newProvider: { type: "llamacpp", baseUrl: "http://127.0.0.1:8080", useApiKey: true },
      apiKey: "synthetic-local-key",
    });
  });

  test("server default and inherit remain distinct, and unsupported providers never submit token budgets", () => {
    expect(validateSetupReasoningFields({ providerType: "llamacpp", supportsThinking: true, reasoningBudgetMode: "server-default" }).input)
      .toEqual({ supportsThinking: true, reasoningBudget: { mode: "server-default" } });
    expect(validateSetupReasoningFields({ providerType: "openai", supportsThinking: true, reasoningBudgetMode: "tokens", reasoningBudgetTokens: "512" }).input)
      .toEqual({ supportsThinking: true });
    expect(parseReasoningBudgetMode("inherit", { mode: "tokens", tokens: 4 })).toBeUndefined();
    expect(parseReasoningBudgetMode("server-default", { mode: "tokens", tokens: 4 })).toEqual({ mode: "server-default" });
    const render = vi.fn(() => "<input />");
    const markup = renderReasoningBudget({ kind: "model", id: "m", config: { generation: { reasoningBudget: { mode: "tokens", tokens: 4 } } } }, ["generation"], render);
    expect(markup).toContain("Token limit");
    expect(render).toHaveBeenCalledWith(expect.anything(), ["generation", "reasoningBudget", "tokens"], expect.anything());
  });
});
