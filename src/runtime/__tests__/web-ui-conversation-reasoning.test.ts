import { describe, expect, test } from "vitest";
import { createConversationReasoning } from "../../web-ui/app/components/conversation-reasoning.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type Disclosure = ContextElement & { open: boolean; inert: boolean };

function setup() {
  const documentRoot = {
    createElement: (tag: string) => Object.assign(new ContextElement(tag), {
      open: false,
      inert: false,
    }),
  } as unknown as Document;
  const view = createConversationReasoning({ documentRoot });
  const message = { id: "thought-1", thinkingText: "A thought with more detail." };
  const render = () => {
    view.beginRender([message]);
    return view.createNode(message) as unknown as Disclosure;
  };
  return { view, message, render };
}

describe("conversation reasoning disclosure", () => {
  test("the text is the native disclosure, with no separate control or title", () => {
    const { render, message } = setup();
    const node = render();
    const summary = node.children[0];
    expect(node.tagName).toBe("details");
    expect(node.open).toBe(false);
    expect(summary.tagName).toBe("summary");
    expect(summary.getAttribute("aria-label")).toBe(message.thinkingText);
    expect(summary.children[0].className).toBe("thinking-body");
    expect((summary.children[0] as Disclosure).inert).toBe(true);
    expect(node.querySelector("button")).toBeNull();
  });

  test("keeps the user's expansion across streaming updates and ignores stale toggles", () => {
    const { render, message } = setup();
    const first = render();
    first.open = true;
    first.dispatch("toggle");
    expect((first.children[0].children[0] as Disclosure).inert).toBe(false);
    message.thinkingText += " Another streamed sentence.";
    const updated = render();
    expect(updated.open).toBe(true);
    first.open = false;
    first.dispatch("toggle");
    expect(render().open).toBe(true);
    const current = render();
    current.open = false;
    current.dispatch("toggle");
    expect(render().open).toBe(false);
  });

  test("forgets expansion when a message leaves the view or the session resets", () => {
    const { view, render } = setup();
    for (const clear of [() => view.beginRender([]), () => view.reset()]) {
      const node = render();
      node.open = true;
      node.dispatch("toggle");
      clear();
      expect(render().open).toBe(false);
    }
    expect(view.createNode({ id: "empty" })).toBeNull();
  });
});
