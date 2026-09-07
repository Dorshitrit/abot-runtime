import { describe, expect, test } from "vitest";
import { createConversationActivity } from "../../web-ui/app/components/conversation-activity.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type ActivityElement = ContextElement & {
  open: boolean;
  scrollTop: number;
  scrollHeight: number;
};

function activity() {
  const frames: Array<() => void> = [];
  const documentRoot = {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), {
        open: false,
        scrollTop: 0,
        scrollHeight: 500,
      }),
    defaultView: {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
    },
  } as unknown as Document;
  const view = createConversationActivity({ documentRoot });
  return {
    view,
    render(events: unknown[], requestId = "request-1", streaming = true) {
      return view.createNode({ requestId, events, streaming })!;
    },
    flushFrames: () => frames.splice(0).forEach((callback) => callback()),
  };
}

function child(root: HTMLElement, selector: string) {
  const found = root.querySelector(selector);
  expect(found).not.toBeNull();
  return found as unknown as ActivityElement;
}

function toolEvent(requestId = "request-1") {
  return {
    requestId,
    eventSequence: 2,
    executionId: "write-1",
    executorRole: "worker",
    name: "tool.completed",
    tool: "write_file",
    ok: true,
    meta: { path: "notes.txt", byteLength: 12 },
  };
}

function diagnostic(requestId = "request-1") {
  return {
    requestId,
    eventSequence: 1,
    name: "agent.status",
    stage: "worker",
    phase: "working",
    message: "Preparing the notes",
  };
}

describe("tool activity timeline availability", () => {
  test.each([true, false])(
    "tool-only activity has no empty timeline option when streaming=%s",
    (streaming) => {
      const { render } = activity();
      const events = [toolEvent()];
      const initial = render(events, "request-1", streaming);
      expect(initial.querySelector(".conversation-role-toggle")).toBeNull();
      expect(child(initial, ".conversation-role-list").hidden).toBe(false);
      expect(child(initial, ".conversation-activity-timeline").hidden).toBe(true);
      const tool = child(initial, ".conversation-tool");
      tool.open = true;
      tool.dispatch("toggle");
      const refreshed = render(events, "request-1", streaming);
      expect(child(refreshed, ".conversation-tool").open).toBe(true);
      expect(refreshed.querySelector(".conversation-role-toggle")).toBeNull();
    },
  );

  test("returns to cards when recorded diagnostics disappear and ignores the obsolete toggle", () => {
    const { render, flushFrames } = activity();
    const events = [diagnostic(), toolEvent()];
    const initial = render(events);
    child(initial, ".conversation-role-toggle").dispatch("click");
    const refreshed = render(events);
    expect(child(refreshed, ".conversation-role-view").dataset.view).toBe(
      "timeline",
    );
    const obsoleteToggle = child(refreshed, ".conversation-role-toggle");
    const toolOnly = render([toolEvent()]);
    expect(toolOnly.querySelector(".conversation-role-toggle")).toBeNull();
    expect(child(toolOnly, ".conversation-role-list").hidden).toBe(false);
    obsoleteToggle.dispatch("click");
    flushFrames();
    expect(child(toolOnly, ".conversation-activity-body").scrollTop).toBe(0);
    const restoredDiagnostics = render(events);
    expect(
      child(restoredDiagnostics, ".conversation-role-view").dataset.view,
    ).toBe("cards");
    child(restoredDiagnostics, ".conversation-role-toggle").dispatch("click");
    const timeline = child(restoredDiagnostics, ".conversation-activity-timeline");
    expect(timeline.hidden).toBe(false);
    expect(timeline.textContent).toContain("Preparing the notes");
  });

  test("an empty timeline in another request does not discard an available timeline choice", () => {
    const { render } = activity();
    const events = [diagnostic(), toolEvent()];
    child(render(events), ".conversation-role-toggle").dispatch("click");
    const other = render([toolEvent("request-2")], "request-2");
    expect(other.querySelector(".conversation-role-toggle")).toBeNull();
    expect(child(render(events), ".conversation-role-view").dataset.view).toBe(
      "timeline",
    );
  });

  test.each(["forget", "reset"] as const)(
    "%s prevents an obsolete toggle from restoring a discarded selection",
    (operation) => {
      const { view, render } = activity();
      const events = [diagnostic(), toolEvent()];
      const obsoleteToggle = child(render(events), ".conversation-role-toggle");
      if (operation === "forget") view.forget("request-1");
      if (operation === "reset") view.reset();
      obsoleteToggle.dispatch("click");
      expect(child(render(events), ".conversation-role-view").dataset.view).toBe(
        "cards",
      );
    },
  );
});

describe("recorded tool input excerpts", () => {
  test.each([
    ["tool.completed", "write_file", "Sent content excerpt"],
    ["tool.payload.completed", "write_file", "Prepared content excerpt"],
    ["tool.payload.completed", "edit_file", "Instruction"],
  ])(
    "%s for %s keeps the bounded input's meaning in its label",
    (name, tool, label) => {
      const inputPreview = "Recorded input. ".repeat(100);
      const node = activity().render([{
        ...toolEvent(),
        name,
        tool,
        meta: {
          path: "notes.txt",
          inputPreview,
          contentLength: inputPreview.length,
        },
      }]);
      const input = child(node, ".conversation-tool-preview");
      expect(input.textContent).toHaveLength(500);
      expect(input.textContent).toBe(`${inputPreview.slice(0, 499)}…`);
      expect(input.getAttribute("aria-label")).toBe(label);
      expect(child(node, ".conversation-tool-preview-label").textContent).toBe(
        label,
      );
      expect(node.textContent).toContain(String(inputPreview.length));
    },
  );
});
