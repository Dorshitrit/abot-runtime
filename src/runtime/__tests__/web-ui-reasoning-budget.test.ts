import { afterEach, describe, expect, test, vi } from "vitest";
import { canChooseReasoningBudget, isReasoningPreference, readReasoningPreferenceField, renderReasoningPreferenceField, syncReasoningPreferenceField } from "../../web-ui/app/lib/reasoning-preference.js";
import { createReasoningBudgetController } from "../../web-ui/app/controllers/reasoning-budget-controller.js";
import { createConversationReasoningPreferences } from "../../web-ui/app/services/conversation-reasoning-preferences.js";
import { createRuntimeWebClient } from "../../web-ui/app/services/runtime-web-client.js";
import { createSessionComposerQueue } from "../../web-ui/app/lib/session-composer-queue.js";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser form renderer.
import { renderAutomationNodeInspector, readAutomationNodePatch } from "../../web-ui/app/components/automations/node-inspector.js";
// @ts-expect-error Browser SPARK renderer.
import { createSparkChatSettings } from "../../web-ui/app/components/spark-chat/settings.js";

const profile = { id: "gemma", supportsThinking: true, reasoningControls: { budgetTokens: true } };
const budget = { profileId: "gemma", mode: "budget" as const, budgetTokens: 128 };
afterEach(() => vi.unstubAllGlobals());
function root() {
  return new FakeElement("section", { activeElement: null } as ConstructorParameters<typeof FakeElement>[1]);
}
function defaults(form: FakeElement) {
  for (const select of form.querySelectorAll("select"))
    select.value = (select.querySelector("option[selected]") || select.querySelector("option"))?.value || "";
}
const asForm = (form: FakeElement) => form as unknown as ParentNode;
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("thinking budget controls", () => {
  test("requires both model permission and declared provider budget capability", () => {
    expect(canChooseReasoningBudget(profile)).toBe(true);
    expect(canChooseReasoningBudget({ ...profile, supportsThinking: false })).toBe(false);
    expect(canChooseReasoningBudget({ id: "gemma", supportsThinking: true })).toBe(false);
  });
  test.each([-1, 1.5, NaN, Infinity, 2147483648])("rejects invalid budget %s", (tokens) => {
    expect(isReasoningPreference({ ...budget, budgetTokens: tokens })).toBe(false);
    const form = root();
    form.innerHTML = renderReasoningPreferenceField(profile, budget); defaults(form);
    form.querySelector("[data-reasoning-budget]")!.value = String(tokens);
    expect(() => readReasoningPreferenceField(asForm(form))).toThrow("whole thinking token budget");
  });
  test("model switches clear the old binding and reveal provider-specific controls", () => {
    const form = root();
    form.innerHTML = renderReasoningPreferenceField(profile, budget); defaults(form);
    expect(readReasoningPreferenceField(asForm(form))).toEqual(budget);
    syncReasoningPreferenceField(asForm(form), { id: "cloud", supportsThinking: true });
    expect(readReasoningPreferenceField(asForm(form))).toBeUndefined();
    expect(form.querySelector("[data-reasoning-preference]")!.hidden).toBe(true);
    syncReasoningPreferenceField(asForm(form), profile);
    expect(form.querySelector("[data-reasoning-preference]")!.hidden).toBe(false);
    expect(form.querySelector("[data-reasoning-budget]")!.value).toBe("");
  });
  test("unavailable saved overrides require an explicit clear", () => {
    const form = root();
    form.innerHTML = renderReasoningPreferenceField({ ...profile, supportsThinking: false }, budget); defaults(form);
    expect(() => readReasoningPreferenceField(asForm(form))).toThrow("does not support");
    form.querySelector("[data-reasoning-preference-mode]")!.value = "inherit";
    expect(readReasoningPreferenceField(asForm(form))).toBeUndefined();
  });
  test("conversation dialog saves locally scoped settings without changing global effort", async () => {
    const preferences = createConversationReasoningPreferences(storage());
    const scope = { environmentId: "prod", sessionId: "chat" };
    const button = root(), menu = root();
    for (const element of [button, menu]) Object.assign(element, { classList: { toggle: vi.fn(), add: vi.fn() } });
    const state = { reasoningBudgetMenuOpen: true };
    const controller = createReasoningBudgetController({ state,
      dom: { reasoningBudgetButton: button as unknown as HTMLButtonElement, reasoningBudgetMenu: menu as unknown as HTMLElement },
      preferences, getScope: () => scope, getProfile: () => profile });
    expect(controller.render()).toBe(true); defaults(menu);
    menu.querySelector("[data-reasoning-preference-mode]")!.value = "budget";
    menu.querySelector("[data-reasoning-preference-mode]")!.dispatch("change");
    menu.querySelector("[data-reasoning-budget]")!.value = "96";
    controller.render();
    expect(menu.querySelector("[data-reasoning-budget]")!.value).toBe("96");
    menu.querySelector("[data-save-budget]")!.dispatch("click");
    await vi.waitFor(() => expect(state.reasoningBudgetMenuOpen).toBe(false));
    expect(controller.selectedPreference()).toEqual({ ...budget, budgetTokens: 96 });
    expect(preferences.loadReasoningPreference({ ...scope, sessionId: "other" }, "gemma")).toBeUndefined();
  });
  test("the composer refuses a saved override when its model loses budget support", () => {
    const preferences = createConversationReasoningPreferences(storage());
    const scope = { environmentId: "prod", sessionId: "chat" };
    preferences.saveReasoningPreference(scope, "gemma", budget);
    let current = { ...profile };
    const controller = createReasoningBudgetController({ state: { reasoningBudgetMenuOpen: false },
      dom: { reasoningBudgetButton: root() as unknown as HTMLButtonElement, reasoningBudgetMenu: root() as unknown as HTMLElement },
      preferences, getScope: () => scope, getProfile: () => current });
    expect(controller.selectedPreference()).toEqual(budget);
    current = { ...profile, supportsThinking: false };
    expect(() => controller.selectedPreference()).toThrow("no longer supports");
    preferences.saveReasoningPreference(scope, "gemma", undefined);
    expect(controller.selectedPreference()).toBeUndefined();
  });
  test("Studio uses current provider budget support and drops stale authoring metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => Response.json(String(url).includes("/chat/models")
      ? { profiles: [{ id: "gemma", supportsThinking: true }] }
      : { models: [{ ...profile }], operations: [] }));
    const client = createRuntimeWebClient({ getConfig: () => ({ backend: "runtime" }), getEnvironmentId: () => "prod", fetchImpl, origin: "http://localhost" });
    const catalog = await client.getAutomationCatalog("automation");
    expect(catalog.models).toEqual([{ id: "gemma", supportsThinking: true }]);
  });
  test("queue storage rejects malformed and mismatched overrides", () => {
    const queue = createSessionComposerQueue({ storage: storage() });
    const item = { waitForRequestId: "active", text: "next", attachments: [], agentMode: "fast",
      toolPermissionMode: "ask", modelPreference: { profileId: "gemma" }, reasoningPreference: budget };
    expect(queue.enqueue({ environmentId: "prod", sessionId: "chat" }, item).reasoningPreference).toEqual(budget);
    expect(() => queue.enqueue({ environmentId: "prod", sessionId: "chat" },
      { ...item, reasoningPreference: { ...budget, profileId: "other" } })).toThrow("Invalid session composer queue item");
    expect(() => queue.enqueue({ environmentId: "prod", sessionId: "chat" },
      { ...item, reasoningPreference: { ...budget, budgetTokens: -1 } })).toThrow("Invalid session composer queue item");
  });
  test("Studio submits the numeric override and emits null when explicitly cleared", () => {
    const node = { id: "agent", kind: "agent", title: "Agent", modelProfileId: "gemma", agentMode: "fast",
      prompt: "Reply", inputs: {}, tools: [], result: { kind: "text" }, reasoningPreference: budget };
    const catalog = { models: [profile], operations: [] };
    const container = root(); container.innerHTML = renderAutomationNodeInspector(node, catalog);
    const form = container.querySelector("form")!; defaults(form);
    vi.stubGlobal("FormData", class {
      constructor(private form: FakeElement) {}
      get(name: string) { return this.form.querySelector(`[name="${name}"]`)?.value ?? null; }
    });
    expect(readAutomationNodePatch(form, node, catalog).reasoningPreference).toEqual(budget);
    form.querySelector("[data-reasoning-preference-mode]")!.value = "inherit";
    expect(readAutomationNodePatch(form, node, catalog).reasoningPreference).toBeNull();
  });
  test("SPARK presents exact token choices and retains an unsaved budget during background refresh", async () => {
    const card = root(); let saved: typeof budget | undefined;
    const onSave = vi.fn(async (preference) => { saved = preference; });
    const settings = createSparkChatSettings({ root: { querySelector: () => ({ prepend() {} }) },
      documentRoot: { createElement: () => card }, getAgentMode: () => "fast", getWebConfig: () => ({}),
      getReasoningPreference: () => saved, onReasoningPreferenceChange: onSave });
    const config = { ...profile, sessionId: "spark", modelProfileId: "gemma" };
    settings.render(config, "prod"); defaults(card);
    const mode = card.querySelector("[data-reasoning-preference-mode]")!;
    mode.value = "budget"; mode.dispatch("change");
    card.querySelector("[data-reasoning-budget]")!.value = "144";
    settings.render(config, "prod");
    expect(card.querySelector("[data-reasoning-budget]")!.value).toBe("144");
    card.querySelector("[data-spark-save-thinking]")!.dispatch("click");
    await vi.waitFor(() => expect(saved).toEqual({ ...budget, budgetTokens: 144 }));
  });
});
