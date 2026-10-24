import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
import { createConversationReasoningPreferences } from "../../web-ui/app/services/conversation-reasoning-preferences.js";
// @ts-expect-error Browser controller.
import { createReasoningModeController } from "../../web-ui/app/controllers/reasoning-mode-controller.js";
// @ts-expect-error Browser form controls.
import { clearReasoningOffForMode, renderReasoningModeField, retainedReasoningMode, syncReasoningModeField } from "../../web-ui/app/lib/reasoning-controls.js";
// @ts-expect-error Browser form renderer.
import { renderAutomationNodeInspector, readAutomationNodePatch } from "../../web-ui/app/components/automations/node-inspector.js";
// @ts-expect-error Browser SPARK renderer.
import { createSparkChatSettings } from "../../web-ui/app/components/spark-chat/settings.js";
import type { ModelReasoningPreference } from "../../shared/model-reasoning.js";

const profile = { id: "gemma", supportsThinking: true, reasoningControls: { budgetTokens: true } };
const manualModes: ModelReasoningPreference[] = [
  { profileId: "gemma", mode: "off" },
  { profileId: "gemma", mode: "budget", budgetTokens: 128 },
  { profileId: "gemma", mode: "server-default" },
];
afterEach(() => vi.unstubAllGlobals());
function root() {
  return Object.assign(new FakeElement("section", { activeElement: null } as ConstructorParameters<typeof FakeElement>[1]),
    { classList: { toggle: vi.fn(), add: vi.fn() } });
}
function defaults(form: FakeElement) {
  for (const select of form.querySelectorAll("select"))
    select.value = (select.querySelector("option[selected]") || select.querySelector("option"))?.value || "";
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness(preference?: ModelReasoningPreference) {
  const values = new Map<string, string>();
  const preferences = createConversationReasoningPreferences({
    getItem: (key: string) => values.get(key) || null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
  let scope = { environmentId: "prod", sessionId: "chat" };
  let selectedProfile = profile;
  if (preference) preferences.saveReasoningPreference(scope, profile.id, preference);
  const menu = root(), button = root(), budgetMenu = root(), budgetButton = root(), budgetControl = root();
  const state = { agentMode: "reasoning", agentModeMenuOpen: true, reasoningBudgetMenuOpen: true, supportedAgentModes: ["fast", "reasoning", "deep"] };
  const client = { setAgentMode: vi.fn(async (mode: string) => ({ mode })) };
  const events = vi.fn();
  const controller = createReasoningModeController({
    state, dom: { agentModeButton: button, agentModeMenu: menu, reasoningBudgetButton: budgetButton, reasoningBudgetMenu: budgetMenu, reasoningBudgetControl: budgetControl }, client, preferences,
    getScope: () => scope, selectedEnvironmentId: () => scope.environmentId,
    selectedModelProfile: () => selectedProfile, reloadModels: vi.fn(), recordControlEvent: events,
  });
  controller.renderAgentMode(); defaults(menu); defaults(budgetMenu);
  return { controller, preferences, menu, button, budgetMenu, budgetButton, budgetControl, state, client, events,
    setScope: (next: typeof scope) => { scope = next; },
    setProfile: (next: typeof profile) => { selectedProfile = next; } };
}

describe("independent reasoning depth and token budget", () => {
  test.each(manualModes)("selecting the current mode retains $mode unless thinking was Off", async (preference) => {
    const h = harness(preference);
    h.preferences.saveReasoningPreference({ environmentId: "prod", sessionId: "other" }, "gemma", preference);
    expect(h.menu.querySelectorAll("[data-mode]").map((item) => item.dataset.mode)).toEqual(["fast", "reasoning", "deep"]);
    expect(h.button.textContent).toContain("Reasoning");
    expect(h.budgetControl.hidden).toBe(false);
    await expect(h.controller.setAgentMode("reasoning")).resolves.toBe(true);
    expect(h.controller.selectedReasoningPreference()).toEqual(preference.mode === "off" ? undefined : preference);
    expect(h.preferences.loadReasoningPreference({ environmentId: "prod", sessionId: "other" }, "gemma")).toEqual(preference);
    expect(h.button.textContent).toContain("Reasoning");
  });

  test("a failed mode write preserves the manual override", async () => {
    const h = harness(manualModes[0]);
    h.client.setAgentMode.mockRejectedValueOnce(new Error("mode denied"));
    await expect(h.controller.setAgentMode("deep")).resolves.toBe(false);
    expect(h.state.agentMode).toBe("reasoning");
    expect(h.controller.selectedReasoningPreference()).toEqual(manualModes[0]);
    expect(h.menu.querySelector("[data-mode-error]")!.textContent).toContain("mode denied");
  });

  test("a failed preference clear reports the retained override without rolling back the saved mode", async () => {
    const h = harness(manualModes[0]);
    vi.spyOn(h.preferences, "saveReasoningPreference").mockRejectedValueOnce(new Error("workspace offline"));
    await expect(h.controller.setAgentMode("deep")).resolves.toBe(false);
    expect(h.state.agentMode).toBe("deep");
    expect(h.controller.selectedReasoningPreference()).toEqual(manualModes[0]);
    expect(h.menu.querySelector("[data-mode-error]")!.textContent).toContain("could not be cleared");
    expect(h.state.agentModeMenuOpen).toBe(true);
  });

  test("a delayed clear targets the original scope after environment and model navigation", async () => {
    const h = harness(manualModes[0]);
    const pending = deferred<{ mode: string }>();
    h.client.setAgentMode.mockReturnValueOnce(pending.promise);
    const saving = h.controller.setAgentMode("deep");
    h.setScope({ environmentId: "dev", sessionId: "next" });
    h.setProfile({ ...profile, id: "other" });
    h.preferences.saveReasoningPreference({ environmentId: "dev", sessionId: "next" }, "other", { profileId: "other", mode: "off" });
    h.state.agentMode = "fast";
    pending.resolve({ mode: "deep" });
    await expect(saving).resolves.toBe(false);
    expect(h.state.agentMode).toBe("fast");
    expect(h.preferences.loadReasoningPreference({ environmentId: "prod", sessionId: "chat" }, "gemma")).toBeUndefined();
    expect(h.controller.selectedReasoningPreference()).toEqual({ profileId: "other", mode: "off" });
  });

  test.each([true, false])("mode settlement after profile navigation does not steal focus or open its menu (success=%s)", async (success) => {
    const h = harness(manualModes[0]);
    const pending = deferred<{ mode: string }>();
    h.client.setAgentMode.mockReturnValueOnce(pending.promise);
    const saving = h.controller.setAgentMode("deep");
    h.setProfile({ ...profile, id: "other" });
    const focus = vi.spyOn(h.button, "focus");
    if (success) pending.resolve({ mode: "deep" });
    else pending.reject(new Error("mode failed"));
    await saving;
    expect(h.state.agentModeMenuOpen).toBe(false);
    expect(focus).not.toHaveBeenCalled();
  });

  test("manual saves and mode changes cannot overlap or replace the numeric draft on a refresh", async () => {
    const h = harness();
    const pending = deferred<void>();
    const focusEnabled: boolean[] = [];
    vi.spyOn(h.budgetButton, "focus").mockImplementation(() => { focusEnabled.push(!h.budgetButton.disabled); });
    vi.spyOn(h.preferences, "saveReasoningPreference").mockReturnValueOnce(pending.promise);
    const choice = h.budgetMenu.querySelector("[data-reasoning-preference-mode]")!;
    choice.value = "budget"; choice.dispatch("change");
    const tokens = h.budgetMenu.querySelector("[data-reasoning-budget]")!;
    tokens.value = "123";
    tokens.focus();
    h.state.agentMode = "deep";
    h.state.supportedAgentModes = ["fast", "reasoning", "deep", "auto"];
    h.controller.renderAgentMode();
    expect(h.budgetMenu.ownerDocument.activeElement).toBe(tokens);
    expect(h.budgetMenu.querySelector("[data-reasoning-budget]")).toBe(tokens);
    expect(h.menu.querySelectorAll("[data-mode]")).toHaveLength(4);
    expect(h.menu.querySelector('[data-mode="deep"]')!.attributes.get("aria-checked")).toBe("true");
    h.budgetMenu.querySelector("[data-save-budget]")!.dispatch("click");
    await expect(h.controller.setAgentMode("fast")).resolves.toBe(false);
    expect(h.client.setAgentMode).not.toHaveBeenCalled();
    pending.resolve();
    await vi.waitFor(() => expect(h.button.disabled).toBe(false));
    expect(focusEnabled).toEqual([true]);
  });

  test("an unsupported profile still exposes a saved budget so it can be cleared", () => {
    const h = harness(manualModes[0]);
    h.setProfile({ ...profile, reasoningControls: { budgetTokens: false } });
    h.controller.renderAgentMode();
    expect(h.budgetControl.hidden).toBe(false);
    expect(h.budgetMenu.querySelector("[data-reasoning-preference]")).not.toBeNull();
  });

  test("clearing a stale unsupported budget returns focus to the visible effort control", async () => {
    const h = harness(manualModes[0]);
    h.setProfile({ ...profile, reasoningControls: { budgetTokens: false } });
    h.controller.renderAgentMode(); defaults(h.budgetMenu);
    const focus = vi.spyOn(h.button, "focus");
    const hiddenFocus = vi.spyOn(h.budgetButton, "focus");
    h.budgetMenu.querySelector("[data-reasoning-preference-mode]")!.value = "inherit";
    h.budgetMenu.querySelector("[data-save-budget]")!.dispatch("click");
    await vi.waitFor(() => expect(h.budgetControl.hidden).toBe(true));
    expect(focus).toHaveBeenCalledOnce();
    expect(hiddenFocus).not.toHaveBeenCalled();
  });

  test("OpenAI and Ollama retain their existing mode menu without budget controls", async () => {
    const h = harness();
    h.setProfile({ ...profile, reasoningControls: { budgetTokens: false } });
    h.controller.renderAgentMode();
    expect(h.menu.querySelectorAll("[data-mode]")).toHaveLength(3);
    expect(h.budgetControl.hidden).toBe(true);
    expect(h.budgetMenu.hidden).toBe(true);
    await expect(h.controller.setAgentMode("fast")).resolves.toBe(true);
  });

  test("form mode selection preserves a numeric budget and its mode on model changes", () => {
    const form = root();
    form.innerHTML = '<select name="modelProfileId"><option selected value="gemma">Gemma</option></select>' + renderReasoningModeField("fast", profile, undefined, manualModes[1]);
    defaults(form);
    const select = form.querySelector("[data-reasoning-mode]")!;
    expect(form.querySelector("[data-legacy-reasoning]")!.hidden).toBe(false);
    expect(select.value).toBe("fast");
    expect(retainedReasoningMode(form, "deep")).toBe("fast");
    select.value = "fast";
    clearReasoningOffForMode(form, [profile]);
    expect(form.querySelector("[data-reasoning-preference-mode]")!.value).toBe("budget");
    expect(form.querySelector("[data-reasoning-budget]")!.value).toBe("128");
    form.querySelector('[name="modelProfileId"]')!.value = "cloud";
    syncReasoningModeField(form, [profile, { id: "cloud", supportsThinking: false }]);
    expect(retainedReasoningMode(form, "deep")).toBe("fast");
  });

  test.each(manualModes)("Studio preserves $mode independently, clearing only explicit Off", (preference) => {
    const node = { id: "agent", kind: "agent", title: "Agent", modelProfileId: "gemma", agentMode: "fast",
      prompt: "Reply", inputs: {}, tools: [], result: { kind: "text" }, reasoningPreference: preference };
    const catalog = { models: [profile], operations: [] };
    const container = root(); container.innerHTML = renderAutomationNodeInspector(node, catalog);
    const form = container.querySelector("form")!; defaults(form);
    vi.stubGlobal("FormData", class {
      constructor(private form: FakeElement) {}
      get(name: string) { return this.form.querySelector(`[name="${name}"]`)?.value ?? null; }
    });
    form.querySelector("[data-reasoning-mode]")!.value = "deep";
    clearReasoningOffForMode(form, catalog.models);
    expect(readAutomationNodePatch(form, node, catalog)).toMatchObject({ agentMode: "deep", reasoningPreference: preference.mode === "off" ? null : preference });
  });

  test("SPARK keeps both independent controls visible and clears only Off after a mode change", async () => {
    const card = root(); let preference: ModelReasoningPreference | undefined = manualModes[0];
    let mode = "reasoning";
    const settings = createSparkChatSettings({ root: { querySelector: () => ({ prepend() {} }) },
      documentRoot: { createElement: () => card }, getAgentMode: () => mode, getWebConfig: () => ({}),
      getReasoningPreference: () => preference,
      onAgentModeChange: async (next: string) => { preference = undefined; mode = next; },
    });
    settings.render({ ...profile, sessionId: "spark", modelProfileId: "gemma" }, "prod"); defaults(card);
    expect(card.querySelector("[data-spark-legacy-reasoning]")!.hidden).toBe(false);
    const select = card.querySelector("[data-spark-agent-mode]")!;
    expect(select.value).toBe("reasoning");
    select.value = "deep"; select.dispatch("change");
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    expect(card.querySelector("[data-reasoning-preference-mode]")!.querySelector("option[selected]")!.value).toBe("inherit");
    expect(select.querySelector('[value="deep"]')!.hasAttribute("selected")).toBe(true);
  });
  test("SPARK restores the selected mode after failed clear and retains an unsaved budget", async () => {
    const card = root();
    const settings = createSparkChatSettings({ root: { querySelector: () => ({ prepend() {} }) },
      documentRoot: { createElement: () => card }, getAgentMode: () => "fast", getWebConfig: () => ({}),
      getReasoningPreference: () => manualModes[1],
      onAgentModeChange: async () => { throw new Error("workspace offline"); },
    });
    settings.render({ ...profile, sessionId: "spark", modelProfileId: "gemma" }, "prod"); defaults(card);
    const tokens = card.querySelector("[data-reasoning-budget]")!;
    tokens.value = "247";
    const select = card.querySelector("[data-spark-agent-mode]")!;
    select.value = "deep"; select.dispatch("change");
    await vi.waitFor(() => expect(card.querySelector("[data-spark-settings-feedback]")!.textContent).toContain("workspace offline"));
    expect(select.querySelector('option[selected]')!.value).toBe("fast");
    expect(card.querySelector("[data-reasoning-budget]")).toBe(tokens);
    expect(tokens.value).toBe("247");
    expect(card.querySelector("[data-reasoning-preference-mode]")!.value).toBe("budget");
  });

});
