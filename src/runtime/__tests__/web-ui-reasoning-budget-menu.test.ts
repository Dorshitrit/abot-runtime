import { expect, test, vi } from "vitest";
import { FakeElement } from "./support/model-setup-wizard-harness.js";
// @ts-expect-error Browser event owner.
import { bindReasoningBudgetMenu } from "../../web-ui/app/controllers/reasoning-budget-menu-events.js";

function harness() {
  const owner = {} as ConstructorParameters<typeof FakeElement>[1];
  function create(tag = "button") {
    const events = new Map<string, ((event: any) => void)[]>();
    return Object.assign(new FakeElement(tag, owner), {
      addEventListener(type: string, listener: (event: any) => void) {
        events.set(type, [...(events.get(type) || []), listener]);
      },
      dispatch(type: string, details: Record<string, unknown> = {}) {
        const event = { target: this, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...details };
        for (const listener of events.get(type) || []) listener(event);
        return event;
      },
    });
  }
  const documentRoot = create("document");
  const state = { reasoningBudgetMenuOpen: false, agentModeMenuOpen: true, permissionModeMenuOpen: true };
  const dom = { reasoningBudgetButton: create(), reasoningBudgetMenu: create("section"), reasoningBudgetControl: create("div"),
    agentModeButton: create(), permissionModeButton: create() };
  dom.reasoningBudgetMenu.innerHTML = '<select data-reasoning-preference-mode><option value="budget">Budget</option></select><input data-reasoning-budget value="128">';
  const actions = { renderAgentMode: vi.fn(), renderPermissionMode: vi.fn() };
  const modelSelector = { close: vi.fn() };
  bindReasoningBudgetMenu({ state, dom, actions, modelSelector, documentRoot });
  return { state, dom, actions, modelSelector, documentRoot };
}

test("budget has its own trigger and opens without changing the effort selection", () => {
  const h = harness();
  h.dom.reasoningBudgetButton.dispatch("click");
  expect(h.state).toEqual({ reasoningBudgetMenuOpen: true, agentModeMenuOpen: false, permissionModeMenuOpen: false });
  expect(h.dom.reasoningBudgetMenu.ownerDocument.activeElement).toBe(h.dom.reasoningBudgetMenu.querySelector("select"));
  expect(h.modelSelector.close).toHaveBeenCalledOnce();
  h.dom.agentModeButton.dispatch("click");
  expect(h.state.reasoningBudgetMenuOpen).toBe(false);
  expect(h.dom.reasoningBudgetMenu.querySelector("input")!.value).toBe("128");
});

test("Escape closes only the open budget popup and returns focus to its own button", () => {
  const h = harness();
  h.dom.reasoningBudgetButton.dispatch("keydown", { key: "ArrowDown" });
  expect(h.state.reasoningBudgetMenuOpen).toBe(true);
  h.documentRoot.dispatch("keydown", { key: "Escape" });
  expect(h.state.reasoningBudgetMenuOpen).toBe(false);
  expect(h.dom.reasoningBudgetMenu.ownerDocument.activeElement).toBe(h.dom.reasoningBudgetButton);
});

test("outside click closes the budget popup and input arrow keys remain native", () => {
  const h = harness();
  h.dom.reasoningBudgetButton.dispatch("click");
  const arrow = h.dom.reasoningBudgetMenu.dispatch("keydown", { key: "ArrowUp" });
  expect(arrow.preventDefault).not.toHaveBeenCalled();
  expect(h.state.reasoningBudgetMenuOpen).toBe(true);
  h.documentRoot.dispatch("click");
  expect(h.state.reasoningBudgetMenuOpen).toBe(false);
});

test("a hidden unsupported budget control cannot be opened by keyboard", () => {
  const h = harness();
  h.dom.reasoningBudgetControl.hidden = true;
  h.dom.reasoningBudgetButton.dispatch("keydown", { key: "ArrowDown" });
  expect(h.state.reasoningBudgetMenuOpen).toBe(false);
});
