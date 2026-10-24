import { afterEach, expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Existing browser factory is not declared in the form input declaration.
import { createScheduleForm } from "../../web-ui/app/components/schedules/form.js";

afterEach(() => vi.unstubAllGlobals());
const profile = { id: "gemma", supportsThinking: true, reasoningControls: { budgetTokens: true } };
const preference = { profileId: "gemma", mode: "budget", budgetTokens: 128 };
function fixture({ editing = false, available = true } = {}) {
  const form = new FakeElement("form", {} as ConstructorParameters<typeof FakeElement>[1]);
  Object.assign(form, { elements: { namedItem: (name: string) => form.querySelector(`[name="${name}"]`) } });
  const html = Object.getOwnPropertyDescriptor(FakeElement.prototype, "innerHTML")!;
  Object.defineProperty(form, "innerHTML", {
    get: () => html.get!.call(form),
    set: (value: string) => {
      html.set!.call(form, value);
      for (const select of form.querySelectorAll("select"))
        select.value = (select.querySelector("option[selected]") || select.querySelector("option"))?.value || "";
    },
  });
  vi.stubGlobal("FormData", class {
    private values = new Map<string, string>();
    constructor(element: FakeElement) {
      for (const field of element.querySelectorAll("[name]")) {
        if (!field.disabled) this.values.set(field.attributes.get("name")!, field.value || (field.tagName === "TEXTAREA" ? field.textContent : ""));
      }
    }
    get(name: string) { return this.values.get(name) || null; }
    getAll(name: string) { return this.values.has(name) ? [this.values.get(name)] : []; }
    set(name: string, value: string) { this.values.set(name, value); }
    [Symbol.iterator]() { return this.values.entries(); }
  });
  const save = vi.fn(async (_input: Record<string, unknown>) => {});
  const values = { title: "Brief", prompt: "Summarize", sessionId: "chat", modelProfileId: "gemma",
    agentMode: "fast", timeZone: "UTC", schedule: { kind: "timer", delayMs: 1000 },
    ...(editing ? { reasoningPreference: preference } : {}) };
  createScheduleForm({ documentRoot: { createElement: () => form },
    ...(editing ? { job: values } : { initialValues: values }),
    sessions: [{ id: "chat" }], models: [{ ...profile, supportsThinking: available }],
    modes: ["fast", "reasoning", "deep"], currentSessionId: "chat", onSave: save, onCancel() {} });
  return { form, save };
}

test.each([0, 128])("schedule creation preserves the bound numeric budget %i", async (budgetTokens) => {
  const { form, save } = fixture();
  const mode = form.querySelector("[data-reasoning-preference-mode]")!;
  mode.value = "budget"; mode.dispatch("change");
  form.querySelector("[data-reasoning-budget]")!.value = String(budgetTokens);
  form.dispatch("submit");
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save.mock.calls[0][0]).toMatchObject({
    agentMode: "fast", reasoningPreference: { ...preference, budgetTokens },
  });
});

test("editing can clear a saved override even after model capability disappears", async () => {
  const { form, save } = fixture({ editing: true, available: false });
  expect(form.querySelector("[data-reasoning-preference]")!.hidden).toBe(false);
  form.querySelector("[data-reasoning-preference-mode]")!.value = "inherit";
  form.querySelector("[data-reasoning-preference-mode]")!.dispatch("change");
  form.dispatch("submit");
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ reasoningPreference: null }));
});

test("invalid custom token input cannot be submitted", async () => {
  const { form, save } = fixture({ editing: true });
  form.querySelector("[data-reasoning-budget]")!.value = "-1";
  form.dispatch("submit");
  await vi.waitFor(() => expect(form.querySelector(".schedule-form-feedback")!.hidden).toBe(false));
  expect(save).not.toHaveBeenCalled();
  expect(form.querySelector(".schedule-form-feedback")!.textContent).toContain("whole thinking token budget");
});

test("selecting a shared mode preserves a saved schedule token budget", async () => {
  const { form, save } = fixture({ editing: true });
  const mode = form.querySelector("[data-reasoning-mode]")!;
  expect(mode.value).toBe("fast");
  mode.value = "deep";
  mode.dispatch("change");
  form.dispatch("submit");
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith({ agentMode: "deep" }));
});
