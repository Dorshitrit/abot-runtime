import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createSetupViewState } from "../../web-ui/app/components/runtime-setup/view-state.js";

describe("setup keyboard focus across redraws", () => {
  test("restores the same field only after a busy redraw completes and retains the outer viewport", () => {
    const oldField = { dataset: { runtimeSetupField: "embedding-provider" } };
    const newField = { disabled: false, focus: vi.fn() };
    const outer = { scrollTop: 180 };
    const document = { activeElement: oldField as unknown };
    const container = {
      ownerDocument: document,
      contains: (element: unknown) => element === oldField,
      closest: () => outer,
      querySelector: vi.fn(() => newField),
    };
    const view = createSetupViewState(container);
    view.capture();
    document.activeElement = null;
    outer.scrollTop = 0;
    view.restore({ busy: true });
    expect(newField.focus).not.toHaveBeenCalled();
    expect(outer.scrollTop).toBe(180);
    view.capture();
    view.restore({ busy: false });
    expect(container.querySelector).toHaveBeenLastCalledWith(
      '[data-runtime-setup-field="embedding-provider"]',
    );
    expect(newField.focus).toHaveBeenCalledWith({ preventScroll: true });
    view.restore({ focus: true });
    expect(container.querySelector).toHaveBeenLastCalledWith(
      "[data-runtime-setup-title]",
    );
    expect(outer.scrollTop).toBe(0);
  });

  test("leaves plugin control focus to its owning step and resets focus when the environment changes", () => {
    const control = { dataset: { runtimePluginToggle: "filesystem" } };
    const target = { focus: vi.fn() };
    const container = {
      scrollTop: 0,
      ownerDocument: { activeElement: control },
      contains: () => true,
      querySelector: vi.fn(() => target),
    };
    const view = createSetupViewState(container);
    view.restore({ focus: true });
    target.focus.mockClear();
    view.capture();
    view.restore();
    expect(target.focus).not.toHaveBeenCalled();
    view.reset();
    view.restore();
    expect(target.focus).not.toHaveBeenCalled();
  });
  test("does not steal focus when the user moves outside during a pending request", () => {
    const oldButton = { dataset: { runtimeSetupAction: "embedding-discover" } };
    const outsideButton = { type: "button" };
    const document = {
      activeElement: oldButton as unknown,
      body: {},
      documentElement: {},
    };
    const target = { focus: vi.fn() };
    const container = {
      scrollTop: 120,
      ownerDocument: document,
      contains: (element: unknown) => element === oldButton,
      querySelector: vi.fn(() => target),
    };
    const view = createSetupViewState(container);
    view.capture();
    view.restore({ busy: true });
    document.activeElement = outsideButton;
    view.capture();
    view.restore();
    view.restore({ focus: true });
    expect(target.focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(outsideButton);
  });
});
