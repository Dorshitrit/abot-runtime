import { describe, expect, test, vi } from "vitest";
import { ContextElement } from "./support/composer-context-window-dom.js";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { bindSessionSearchDisclosure } from "../../web-ui/app/components/session-search-disclosure.js";

function createSearchDisclosure() {
  const toggle = Object.assign(new ContextElement("button"), { focus: vi.fn() });
  const field = new ContextElement("div");
  const inputElement = Object.assign(new ContextElement("input"), {
    value: "",
    focus: vi.fn(),
  });
  const input = Object.assign(inputElement, {
    dispatchEvent: vi.fn((event: Event) => {
      inputElement.dispatch(event.type);
      return true;
    }),
  });
  field.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  bindSessionSearchDisclosure({ toggle, field, input });
  const onInput = vi.fn();
  input.addEventListener("input", onInput);
  return { toggle, field, input, onInput };
}

describe("session search disclosure", () => {
  test("opens the search field and places keyboard focus in it", () => {
    const { toggle, field, input, onInput } = createSearchDisclosure();

    toggle.dispatch("click");

    expect(field.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(input.focus).toHaveBeenCalledOnce();
    expect(onInput).not.toHaveBeenCalled();
  });

  test.each(["toggle", "Escape"])("%s closes search and clears the active filter", (action) => {
    const { toggle, field, input, onInput } = createSearchDisclosure();
    toggle.dispatch("click");
    input.value = "deployment";
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    if (action === "toggle") toggle.dispatch("click");
    if (action === "Escape") input.dispatch("keydown", event);

    expect(field.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(input.value).toBe("");
    expect(onInput).toHaveBeenCalledOnce();
    expect(input.dispatchEvent).toHaveBeenCalledOnce();
    expect(input.dispatchEvent.mock.calls[0]?.[0]).toMatchObject({ type: "input", bubbles: true });
    expect(toggle.focus).toHaveBeenCalledOnce();
  });

  test("closing an empty search does not emit a redundant filter update", () => {
    const { toggle, field, input, onInput } = createSearchDisclosure();
    toggle.dispatch("click");

    toggle.dispatch("click");

    expect(field.hidden).toBe(true);
    expect(input.dispatchEvent).not.toHaveBeenCalled();
    expect(onInput).not.toHaveBeenCalled();
  });

  test("consumes Escape so the surrounding sidebar does not also close", () => {
    const { toggle, field, input } = createSearchDisclosure();
    toggle.dispatch("click");
    const event = {
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    input.dispatch("keydown", event);

    expect(field.hidden).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  test("leaves ordinary keyboard input to the search field", () => {
    const { toggle, field, input, onInput } = createSearchDisclosure();
    toggle.dispatch("click");
    input.value = "deployment";
    const event = {
      key: "Enter",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    input.dispatch("keydown", event);

    expect(field.hidden).toBe(false);
    expect(input.value).toBe("deployment");
    expect(onInput).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
