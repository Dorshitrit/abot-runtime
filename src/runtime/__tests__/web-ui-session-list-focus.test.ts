import { expect, test, vi } from "vitest";
// @ts-expect-error Browser module.
import { captureSessionListViewport, restoreSessionListViewport } from "../../web-ui/app/components/session-list-viewport.js";
import { SidebarElement } from "./support/session-sidebar-dom.js";

type FocusDocument = { body: SidebarElement; activeElement: SidebarElement | null };

class FocusableSidebarElement extends SidebarElement {
  scrollTop = 0;
  constructor(tag: string, readonly ownerDocument: FocusDocument) { super(tag); }
  getClientRects() { return this.hidden ? [] : [{}]; }
  override focus = vi.fn((_options?: { preventScroll?: boolean }) => {
    this.ownerDocument.activeElement = this;
  });
  override replaceChildren(...children: SidebarElement[]) {
    if (this.contains(this.ownerDocument.activeElement)) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
    this.scrollTop = 0;
    super.replaceChildren(...children);
  }
}

function fixture() {
  const body = new SidebarElement("body");
  const documentRoot: FocusDocument = { body, activeElement: body };
  const root = new FocusableSidebarElement("div", documentRoot);
  const retained = new FocusableSidebarElement("button", documentRoot);
  retained.id = "newProjectButton";
  root.appendChild(retained);
  captureSessionListViewport(root, "dev");
  restoreSessionListViewport(root);
  return {
    root, retained, documentRoot,
    capture(scope = "dev") {
      root.scrollTop = 320;
      retained.focus();
      retained.focus.mockClear();
      captureSessionListViewport(root, scope);
    },
    render(button = retained) {
      root.innerHTML = "";
      const heading = new SidebarElement("div");
      heading.appendChild(button);
      root.appendChild(heading);
    },
  };
}

test("a retained button keeps focus and list position after its heading is rebuilt", () => {
  const f = fixture();
  f.capture();
  f.render();
  expect(f.documentRoot.activeElement).toBe(f.documentRoot.body);
  restoreSessionListViewport(f.root);
  expect(f.documentRoot.activeElement).toBe(f.retained);
  expect(f.retained.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(f.root.scrollTop).toBe(320);
});

test("focus is not transferred to a replacement button with the same id", () => {
  const f = fixture();
  f.capture();
  const replacement = new FocusableSidebarElement("button", f.documentRoot);
  replacement.id = f.retained.id;
  f.render(replacement);
  restoreSessionListViewport(f.root);
  expect(f.documentRoot.activeElement).toBe(f.documentRoot.body);
  expect(f.retained.focus).not.toHaveBeenCalled();
  expect(replacement.focus).not.toHaveBeenCalled();
});

test("a changed list scope discards captured focus and scroll", () => {
  const f = fixture();
  f.capture("prod");
  f.render();
  restoreSessionListViewport(f.root);
  expect(f.retained.focus).not.toHaveBeenCalled();
  expect(f.root.scrollTop).toBe(0);
});

test.each(["list", "button"])("a hidden %s cannot receive restored focus", (hidden) => {
  const f = fixture();
  f.capture();
  f.render();
  const target = hidden === "list" ? f.root : f.retained;
  target.hidden = true;
  restoreSessionListViewport(f.root);
  target.hidden = false;
  restoreSessionListViewport(f.root);
  expect(f.retained.focus).not.toHaveBeenCalled();
  expect(f.documentRoot.activeElement).toBe(f.documentRoot.body);
});

test("focus deliberately moved elsewhere is preserved and consumes the snapshot", () => {
  const f = fixture();
  f.capture();
  f.render();
  const other = new FocusableSidebarElement("button", f.documentRoot);
  other.focus();
  restoreSessionListViewport(f.root);
  expect(f.documentRoot.activeElement).toBe(other);
  f.documentRoot.activeElement = f.documentRoot.body;
  restoreSessionListViewport(f.root);
  expect(f.retained.focus).not.toHaveBeenCalled();
});

test("a successful focus restore is used once", () => {
  const f = fixture();
  f.capture();
  f.render();
  restoreSessionListViewport(f.root);
  f.documentRoot.activeElement = f.documentRoot.body;
  restoreSessionListViewport(f.root);
  expect(f.retained.focus).toHaveBeenCalledTimes(1);
});

test("an already focused retained button does not receive another focus call", () => {
  const f = fixture();
  f.capture();
  restoreSessionListViewport(f.root);
  expect(f.documentRoot.activeElement).toBe(f.retained);
  expect(f.retained.focus).not.toHaveBeenCalled();
});
