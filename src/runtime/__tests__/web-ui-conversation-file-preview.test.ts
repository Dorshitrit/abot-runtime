import { describe, expect, test, vi } from "vitest";
import { createConversationActivity } from "../../web-ui/app/components/conversation-activity.js";
import { createConversationFilePreview } from "../../web-ui/app/components/conversation-file-preview.js";
import type { ConversationFilePreview } from "../../web-ui/app/services/runtime-web-client/conversation-files.js";
import { createFilePreviewDom } from "./support/conversation-file-preview-dom.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

const file: ConversationFilePreview = {
  name: "report.md",
  mimeType: "text/plain",
  size: 30,
  kind: "text",
  content:
    "# Report\n\n<script>alert(1)</script>\n![remote](https://tracker.example/image.png)",
  truncated: false,
  operation: "created",
  location: "report.md",
  downloadAvailable: true,
  nativeOpenAvailable: true,
};
function fileCompletionEvent() {
  return {
    name: "tool.completed",
    requestId: "r1",
    executionId: "e1",
    eventSequence: 1,
    executorRole: "worker",
    tool: "write_file",
    ok: true,
    meta: {
      path: file.name,
      fileOutput: {
        version: 1,
        location: "agent_work",
        rootId: "sha256:" + "a".repeat(64),
        relativePath: file.name,
        logicalPath: file.name,
        operation: "created",
      },
    },
  };
}

function setup(narrow = false) {
  const dom = createFilePreviewDom(narrow);
  const onClose = vi.fn();
  const onOpenNative = vi.fn();
  const view = createConversationFilePreview({
    ...dom,
    host: dom.host as unknown as HTMLElement,
    onClose,
    onOpenNative,
  });
  function open() {
    view.render({
      open: true,
      status: "loading",
      name: file.name,
      opener: dom.opener as unknown as HTMLElement,
    });
  }
  function ready(nextFile = file, urls = {}) {
    view.render({
      open: true,
      status: "ready",
      file: nextFile,
      ...urls,
    });
  }
  return { dom, onClose, onOpenNative, view, open, ready };
}
function node<T extends HTMLElement = HTMLElement>(
  root: HTMLElement,
  selector: string,
) {
  return root.querySelector(selector) as T;
}
function click(element: HTMLElement) {
  (element as unknown as ContextElement).dispatch("click", {
    preventDefault() {},
    stopPropagation() {},
  });
}

describe("current file viewer presentation", () => {
  test("previews Markdown safely and retains complete raw source as a separate view", () => {
    const { view, open, ready } = setup();
    open();
    ready();
    const markdown = node(view.panel, ".conversation-file-markdown");
    expect(markdown.innerHTML).toContain("<h1>Report</h1>");
    expect(markdown.innerHTML).not.toContain("<script>");
    expect(markdown.innerHTML).not.toContain("<img");
    expect(view.panel.textContent).toContain("Current file contents");
  });

  test("source toggle displays current bytes rather than recorded Activity excerpts", () => {
    const { view, open, ready } = setup();
    open();
    ready();
    const modes = node(
      view.panel,
      ".conversation-file-modes",
    ) as unknown as ContextElement;
    modes.children[1].dispatch("click");
    expect(node(view.panel, ".conversation-file-source").textContent).toBe(
      file.content,
    );
  });

  test("unsupported preview types can open on Mac without a menu", () => {
    const { view, open, ready } = setup();
    open();
    ready({
      ...file,
      name: "report.pdf",
      kind: "unsupported",
      mimeType: "application/pdf",
    });
    expect(node(view.panel, ".conversation-file-modes").hidden).toBe(true);
    expect(node(view.panel, ".conversation-file-menu")).toBeNull();
    expect(node(view.panel, ".conversation-file-download")).toBeNull();
    expect(node(view.panel, ".conversation-file-open-native").hidden).toBe(
      false,
    );
    expect(node(view.panel, ".conversation-file-body").textContent).toContain(
      "Preview is not available",
    );
  });

  test("changing the selected file clears previous body, source mode, and native action immediately", () => {
    const { view, open, ready } = setup();
    open();
    ready();
    view.render({ open: true, status: "loading", name: "next.txt" });
    expect(node(view.panel, ".conversation-file-body").textContent).toBe(
      "Loading file…",
    );
    expect(node(view.panel, ".conversation-file-toolbar").hidden).toBe(true);
    expect(node(view.panel, ".conversation-file-markdown")).toBeNull();
    view.render({
      open: true,
      status: "error",
      error: "This file is no longer available.",
    });
    expect(node(view.panel, ".conversation-file-body").textContent).toBe(
      "This file is no longer available.",
    );
  });

  test("rejects external inline images", () => {
    const { view, open, ready } = setup();
    open();
    ready(
      { ...file, kind: "image", mimeType: "image/png" },
      {
        imageUrl: "https://other.example/a.png",
      },
    );
    expect(node(view.panel, ".conversation-file-image")).toBeNull();
    expect(node(view.panel, ".conversation-file-download")).toBeNull();
  });

  test("truncated content directs the user to the original file", () => {
    const { view, open, ready } = setup();
    open();
    ready({
      ...file,
      truncated: true,
      downloadAvailable: false,
      nativeOpenAvailable: false,
    });
    expect(node(view.panel, ".conversation-file-notice").textContent).toContain(
      "Open the original on your computer",
    );
    expect(node(view.panel, ".conversation-file-download")).toBeNull();
  });
});

describe("native action presentation", () => {
  test("only an explicit click opens the file and busy/error state preserves the preview", () => {
    const { view, open, ready, onOpenNative } = setup();
    open();
    ready();
    const action = node<HTMLButtonElement>(
      view.panel,
      ".conversation-file-open-native",
    );
    const body = node(view.panel, ".conversation-file-body");
    const initialContent = body.innerHTML;
    expect(onOpenNative).not.toHaveBeenCalled();
    click(action);
    expect(onOpenNative).toHaveBeenCalledOnce();
    view.render({ open: true, status: "native", nativeStatus: "opening" });
    expect(action.disabled).toBe(true);
    click(action);
    expect(onOpenNative).toHaveBeenCalledOnce();
    view.render({
      open: true,
      status: "native",
      nativeStatus: "error",
      nativeError: "Could not open file",
    });
    expect(action.disabled).toBe(false);
    expect(body.innerHTML).toBe(initialContent);
    expect(
      node(view.panel, ".conversation-file-native-status").textContent,
    ).toBe("Could not open file");
  });

  test("unsupported hosts hide the native action and leave no empty toolbar for text", () => {
    const { view, open, ready, onOpenNative } = setup();
    open();
    ready({ ...file, name: "note.txt", nativeOpenAvailable: false });
    const action = node(view.panel, ".conversation-file-open-native");
    expect(action.hidden).toBe(true);
    expect(node(view.panel, ".conversation-file-toolbar").hidden).toBe(true);
    click(action);
    expect(onOpenNative).not.toHaveBeenCalled();
  });
});

describe("viewer focus and close behavior", () => {
  test("returns focus to Activity after switching to timeline while the side viewer is open", () => {
    const { dom, view } = setup();
    const activity = createConversationActivity({
      documentRoot: dom.documentRoot,
      onOpenFile: (_reference, opener) => {
        view.render({ open: true, status: "loading", name: file.name, opener });
      },
    });
    const current = activity.createNode({
      requestId: "r1",
      streaming: true,
      events: [
        {
          requestId: "r1",
          eventSequence: 0,
          name: "agent.status",
          stage: "worker",
          phase: "working",
          message: "Writing the report",
        },
        fileCompletionEvent(),
      ],
    }) as HTMLDetailsElement;
    dom.chat.replaceChildren(current as unknown as ContextElement);
    click(node(current, ".conversation-tool-file-action"));
    expect(view.panel.hidden).toBe(false);
    click(node(current, ".conversation-role-toggle"));
    const cards = node(current, ".conversation-role-list");
    expect(cards.hidden).toBe(true);

    view.render({ open: false });

    expect(view.panel.hidden).toBe(true);
    expect(dom.activeElement).toBe(
      node(current, ".conversation-activity-summary"),
    );
    expect(cards.hidden).toBe(true);
    expect(current.open).toBe(true);
  });

  test.each([false, true])(
    "returns focus to the collapsed Activity after streaming completes (overlay=%s)",
    (narrow) => {
      const { dom, view } = setup(narrow);
      const activity = createConversationActivity({
        documentRoot: dom.documentRoot,
        onOpenFile: (_reference, opener) => {
          view.render({
            open: true,
            status: "loading",
            name: file.name,
            opener,
          });
        },
      });
      const event = fileCompletionEvent();
      const streaming = activity.createNode({
        requestId: "r1",
        events: [event],
        streaming: true,
      }) as HTMLDetailsElement;
      dom.chat.replaceChildren(streaming as unknown as ContextElement);
      expect(streaming.open).toBe(true);
      click(node(streaming, ".conversation-tool-file-action"));
      expect(view.panel.hidden).toBe(false);

      const completed = activity.createNode({
        requestId: "r1",
        events: [event],
        streaming: false,
      }) as HTMLDetailsElement;
      dom.chat.replaceChildren(completed as unknown as ContextElement);
      expect(completed.open).toBe(false);
      view.render({ open: false });

      expect(view.panel.hidden).toBe(true);
      expect(completed.open).toBe(false);
      expect(dom.activeElement).toBe(
        node(completed, ".conversation-activity-summary"),
      );
    },
  );

  test("a sidebar made interactive by the shell stays interactive when leaving overlay width", () => {
    const { dom, view, open } = setup(true);
    dom.navigation.inert = true;
    open();
    dom.navigation.inert = false;
    dom.resize(false);
    expect(dom.navigation.inert).toBe(false);
    expect(dom.chat.inert).toBe(false);
    expect(view.panel.hidden).toBe(false);
  });

  test("closing for a workspace change preserves newly activated outside content", () => {
    const { dom, view, open } = setup(true);
    const configuration = dom.element("section");
    configuration.inert = true;
    dom.body.appendChild(configuration);
    open();
    configuration.inert = false;
    dom.chat.inert = false;
    view.render({ open: false, restoreFocus: false });
    expect(configuration.inert).toBe(false);
    expect(dom.chat.inert).toBe(false);
    expect(view.panel.hidden).toBe(true);
  });

  test("traps Tab inside the overlay and ignores links in its closed actions menu", () => {
    const { dom, view, open, ready } = setup(true);
    open();
    ready();
    const close = node<HTMLButtonElement>(
      view.panel,
      ".conversation-file-close",
    );
    const body = node(view.panel, ".conversation-file-body");
    const preventDefault = vi.fn();
    (view.panel as unknown as ContextElement).dispatch("keydown", {
      key: "Tab",
      shiftKey: true,
      preventDefault,
    } as unknown as { key: string });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(dom.activeElement).toBe(body);
    const forward = vi.fn();
    (view.panel as unknown as ContextElement).dispatch("keydown", {
      key: "Tab",
      preventDefault: forward,
    });
    expect(forward).toHaveBeenCalledOnce();
    expect(dom.activeElement).toBe(close);
  });

  test("wide view keeps chat usable and closes back to the initiating action", () => {
    const { dom, view, open } = setup();
    open();
    expect(dom.activeElement).toBe(
      node(view.panel, ".conversation-file-close"),
    );
    expect(dom.chat.inert).toBe(false);
    view.render({ open: false });
    expect(dom.activeElement).toBe(dom.opener);
    expect(view.panel.hidden).toBe(true);
  });

  test("overlay makes all outside content inert, handles Escape, and restores existing inert state", () => {
    const { dom, view, open, onClose } = setup(true);
    dom.navigation.inert = true;
    open();
    expect(view.panel.getAttribute("role")).toBe("dialog");
    expect(dom.chat.inert).toBe(true);
    expect(dom.navigation.inert).toBe(true);
    const preventDefault = vi.fn();
    dom.key({ key: "Escape", preventDefault });
    expect(onClose).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    view.render({ open: false, restoreFocus: false });
    expect(dom.chat.inert).toBe(false);
    expect(dom.navigation.inert).toBe(true);
    expect(dom.activeElement).not.toBe(dom.opener);
  });

  test("restores focus to the replacement action after a streaming repaint", () => {
    const { dom, view, open } = setup(true);
    open();
    const replacement = dom.element("button");
    replacement.className = dom.opener.className;
    Object.assign(replacement.dataset, dom.opener.dataset);
    dom.chat.replaceChildren(replacement);
    view.render({ open: false });
    expect(dom.activeElement).toBe(replacement);
  });

  test("resizing out of overlay restores background interactivity without closing the viewer", () => {
    const { dom, view, open } = setup(true);
    open();
    dom.resize(false);
    expect(dom.chat.inert).toBe(false);
    expect(view.panel.hidden).toBe(false);
    expect(view.panel.getAttribute("aria-modal")).toBeNull();
  });
});
