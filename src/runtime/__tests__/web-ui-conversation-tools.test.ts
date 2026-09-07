import { describe, expect, test } from "vitest";
import { createConversationTools } from "../../web-ui/app/components/conversation-tools.js";
import type { ConversationToolAction } from "../../web-ui/app/lib/tool-activity-model.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

type ToolElement = ContextElement & { open: boolean; title: string };

function toolDom() {
  return {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), { open: false, title: "" }),
  } as unknown as Document;
}

function child(root: HTMLElement, selector: string) {
  const found = root.querySelector(selector);
  expect(found).not.toBeNull();
  return found as unknown as ToolElement;
}

function descendants(root: HTMLElement, className: string): ToolElement[] {
  const children = [...(root as unknown as ToolElement).children];
  return children.flatMap((item) => [
    ...(item.classList.contains(className) ? [item as ToolElement] : []),
    ...descendants(item as unknown as HTMLElement, className),
  ]);
}

function action(
  overrides: Partial<ConversationToolAction> = {},
): ConversationToolAction {
  return {
    id: "execution-1",
    tool: "read_file",
    title: "Read file",
    target: "notes/סיכום.txt",
    status: "completed",
    statusLabel: "Completed",
    executed: true,
    intent: "Review the saved notes.",
    sent: [
      { label: "Path", value: "notes/סיכום.txt" },
      { label: "Requested lines", value: "1–12" },
    ],
    received: [{ label: "Read", value: "12 lines" }],
    preview: "First recorded line\nSecond recorded line",
    partial: false,
    previewTruncated: false,
    legacy: false,
    count: 1,
    ...overrides,
  };
}

describe("conversation tool activity", () => {
  test("renders one native disclosure with compact status and recorded sent/received evidence", () => {
    const renderer = createConversationTools({ documentRoot: toolDom() });
    const node = renderer.createNode({
      requestId: "request-1",
      actions: [action()],
    })!;
    expect(node.getAttribute("aria-label")).toBe("Tool activity");
    expect(node.dataset.requestId).toBe("request-1");
    const details = child(node, ".conversation-tool");
    expect(details.tagName).toBe("details");
    expect(details.open).toBe(false);
    expect(details.dataset.actionId).toBe("execution-1");
    const summary = child(node, ".conversation-tool-summary");
    expect(summary.tagName).toBe("summary");
    expect(summary.textContent).toContain("Read file");
    expect(summary.textContent).toContain("Completed");
    expect(summary.textContent).not.toContain("First recorded line");
    expect(child(node, ".conversation-tool-target").title).toBe(
      "notes/סיכום.txt",
    );
    expect(
      descendants(node, "conversation-tool-evidence").map((panel) =>
        panel.getAttribute("aria-label"),
      ),
    ).toEqual(["Sent", "Received"]);
    expect(child(node, ".conversation-tool-preview").textContent).toBe(
      "First recorded line\nSecond recorded line",
    );
    expect(node.querySelector(".conversation-tool-unrecorded")).toBeNull();
  });

  test("keeps tool text inert and mixed Hebrew/path content directionally isolated", () => {
    const untrusted = '<img src=x onerror="alert(1)"> שלום';
    const node = createConversationTools({
      documentRoot: toolDom(),
    }).createNode({
      requestId: "request-1",
      actions: [
        action({
          title: untrusted,
          target: untrusted,
          intent: untrusted,
          sent: [{ label: untrusted, value: untrusted }],
          received: [{ label: "Returned", value: untrusted }],
          preview: untrusted,
        }),
      ],
    })!;
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("script")).toBeNull();
    for (const selector of [
      ".conversation-tool-title",
      ".conversation-tool-target",
      ".conversation-tool-intent",
      ".conversation-tool-preview",
      ".conversation-tool-field-label",
    ]) {
      expect(child(node, selector).getAttribute("dir")).toBe("auto");
      expect(child(node, selector).textContent).toBe(untrusted);
    }
    const value = child(node, ".conversation-tool-field-value");
    expect(
      child(value as unknown as HTMLElement, "bdi").getAttribute("dir"),
    ).toBe("auto");
  });

  test.each([
    ["preparing", "Preparing"],
    ["running", "Running"],
    ["awaiting_approval", "Awaiting approval"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["empty", "No matches"],
    ["unchanged", "Unchanged"],
    ["incomplete", "Incomplete"],
  ] as const)(
    "shows the projected %s outcome as readable text",
    (status, statusLabel) => {
      const node = createConversationTools({
        documentRoot: toolDom(),
      }).createNode({
        requestId: "request-1",
        actions: [action({ status, statusLabel })],
      })!;
      expect(child(node, ".conversation-tool-status").textContent).toBe(
        statusLabel,
      );
      expect(
        child(node, ".conversation-tool").classList.contains(`is-${status}`),
      ).toBe(true);
      expect(
        child(node, ".conversation-tool-symbol").getAttribute("aria-hidden"),
      ).toBe("true");
    },
  );

  test("preserves a user's expansion through preparation, execution and completion", () => {
    const renderer = createConversationTools({ documentRoot: toolDom() });
    const render = (status: ConversationToolAction["status"]) =>
      renderer.createNode({
        requestId: "request-1",
        actions: [action({ status, statusLabel: status })],
      })!;
    const preparing = child(render("preparing"), ".conversation-tool");
    preparing.open = true;
    preparing.dispatch("toggle");
    const running = render("running");
    expect(descendants(running, "conversation-tool-row")).toHaveLength(1);
    expect(child(running, ".conversation-tool").open).toBe(true);
    const completed = child(render("completed"), ".conversation-tool");
    expect(completed.open).toBe(true);
    completed.open = false;
    completed.dispatch("toggle");
    expect(child(render("completed"), ".conversation-tool").open).toBe(false);
  });

  test("isolates disclosure state by request and action and ignores detached toggle events", () => {
    const renderer = createConversationTools({ documentRoot: toolDom() });
    const render = (requestId = "request-1", id = "execution-1") =>
      renderer.createNode({ requestId, actions: [action({ id })] })!;
    const old = child(render(), ".conversation-tool");
    old.open = true;
    old.dispatch("toggle");
    const current = child(render(), ".conversation-tool");
    expect(current.open).toBe(true);
    old.open = false;
    old.dispatch("toggle");
    expect(child(render(), ".conversation-tool").open).toBe(true);
    expect(child(render("request-2"), ".conversation-tool").open).toBe(false);
    expect(
      child(render("request-1", "execution-2"), ".conversation-tool").open,
    ).toBe(false);
    expect(child(render(), ".conversation-tool").open).toBe(true);
  });

  test.each(["forget", "reset"] as const)(
    "clears disclosure with %s and rejects late events from the previous view",
    (method) => {
      const renderer = createConversationTools({ documentRoot: toolDom() });
      const render = () =>
        renderer.createNode({
          requestId: "request-1",
          actions: [action()],
        })!;
      const old = child(render(), ".conversation-tool");
      old.open = true;
      old.dispatch("toggle");
      if (method === "forget") renderer.forget("request-1");
      else renderer.reset();
      const cleared = child(render(), ".conversation-tool");
      expect(cleared.open).toBe(false);
      old.dispatch("toggle");
      expect(child(render(), ".conversation-tool").open).toBe(false);
    },
  );

  test("distinguishes missing evidence from empty results and partial recorded output", () => {
    const renderer = createConversationTools({ documentRoot: toolDom() });
    const missing = renderer.createNode({
      requestId: "request-1",
      actions: [
        action({
          sent: [],
          received: [],
          preview: "",
          legacy: true,
          status: "incomplete",
          statusLabel: "Incomplete",
        }),
      ],
    })!;
    expect(descendants(missing, "conversation-tool-evidence")).toHaveLength(0);
    expect(missing.querySelector(".conversation-tool-unrecorded")).toBeNull();
    expect(missing.textContent).toContain("Limited recorded details");
    expect(missing.textContent).not.toContain("No matches");
    const partial = renderer.createNode({
      requestId: "request-1",
      actions: [action({ received: [], partial: true })],
    })!;
    expect(partial.textContent).toContain("Partial result");
    expect(partial.querySelector(".conversation-tool-unrecorded")).toBeNull();
  });

  test.each([
    ["failed", "Preparation failed"],
    ["failed", "Approval rejected"],
    ["awaiting_approval", "Awaiting approval"],
  ] as const)("does not imply execution for %s / %s", (status, statusLabel) => {
    const node = createConversationTools({
      documentRoot: toolDom(),
    }).createNode({
      requestId: "request-1",
      actions: [action({ executed: false, status, statusLabel })],
    })!;
    expect(
      descendants(node, "conversation-tool-evidence").map((panel) =>
        panel.getAttribute("aria-label"),
      ),
    ).toEqual(["Prepared input", "Status"]);
    expect(child(node, ".conversation-tool-status").textContent).toBe(
      statusLabel,
    );
  });

  test("distinguishes a shortened display excerpt from a partial tool result", () => {
    const renderer = createConversationTools({ documentRoot: toolDom() });
    const node = renderer.createNode({
      requestId: "request-1",
      actions: [action({ previewTruncated: true })],
    })!;
    expect(node.textContent).toContain("Excerpt shortened");
    expect(node.textContent).not.toContain("Partial result");
    const partial = renderer.createNode({
      requestId: "request-1",
      actions: [action({ partial: true, previewTruncated: false })],
    })!;
    expect(partial.textContent).toContain("Partial result");
    expect(partial.textContent).not.toContain("Excerpt shortened");
  });

  test("a metadata-only write uses one compact facts group without repeating its header path", () => {
    const node = createConversationTools({
      documentRoot: toolDom(),
    }).createNode({
      requestId: "request-1",
      actions: [
        action({
          tool: "write_file",
          title: "Write file",
          target: "a.json",
          intent: "",
          sent: [{ label: "Path", value: "a.json" }],
          received: [
            { label: "Bytes", value: "2193" },
            { label: "Change", value: "Created file" },
          ],
          preview: "",
          legacy: true,
        }),
      ],
    })!;
    expect(
      descendants(node, "conversation-tool-evidence").map((panel) =>
        panel.getAttribute("aria-label"),
      ),
    ).toEqual(["Received"]);
    expect(descendants(node, "conversation-tool-field")).toHaveLength(2);
    expect(node.querySelector(".conversation-tool-evidence-title")).toBeNull();
    expect(node.textContent.match(/a\.json/g)).toHaveLength(1);
    expect(node.querySelector(".conversation-tool-preview")).toBeNull();
    expect(descendants(node, "conversation-tool-notice")).toHaveLength(1);
  });

  test.each(["Path", "Folder", "Memory ID", "Target", "Source", "Query"])(
    "omits %s only when it exactly repeats the action target",
    (label) => {
      const renderer = createConversationTools({ documentRoot: toolDom() });
      const render = (value: string) =>
        renderer.createNode({
          requestId: "request-1",
          actions: [action({ sent: [{ label, value }] })],
        })!;
      expect(
        descendants(
          render("notes/סיכום.txt"),
          "conversation-tool-evidence",
        ).map((panel) => panel.getAttribute("aria-label")),
      ).toEqual(["Received"]);
      expect(
        descendants(
          render("./notes/סיכום.txt"),
          "conversation-tool-evidence",
        ).map((panel) => panel.getAttribute("aria-label")),
      ).toEqual(["Sent", "Received"]);
    },
  );

  test("keeps distinct sent content and output excerpts in separate full-width text blocks", () => {
    const node = createConversationTools({
      documentRoot: toolDom(),
    }).createNode({
      requestId: "request-1",
      actions: [
        action({
          sent: [
            { label: "Content excerpt", value: "Input line\nSecond input" },
          ],
          preview: "Output line",
        }),
      ],
    })!;
    expect(descendants(node, "conversation-tool-text-block")).toHaveLength(2);
    expect(
      descendants(node, "conversation-tool-preview").map((preview) => [
        preview.getAttribute("aria-label"),
        preview.textContent,
      ]),
    ).toEqual([
      ["Sent content excerpt", "Input line\nSecond input"],
      ["Returned excerpt", "Output line"],
    ]);
  });

  test("missing extra evidence produces one notice without empty group headings", () => {
    const node = createConversationTools({
      documentRoot: toolDom(),
    }).createNode({
      requestId: "request-1",
      actions: [action({ sent: [], received: [], preview: "", legacy: false })],
    })!;
    expect(descendants(node, "conversation-tool-evidence")).toHaveLength(0);
    expect(descendants(node, "conversation-tool-unrecorded")).toHaveLength(1);
  });

  test("keeps recorded multiplicity visible and omits empty sections", () => {
    const renderer = createConversationTools({ documentRoot: toolDom() });
    const node = renderer.createNode({
      requestId: "request-1",
      actions: [action({ count: 3 })],
    })!;
    expect(child(node, ".conversation-tool-count").textContent).toBe("×3");
    expect(
      renderer.createNode({ requestId: "request-1", actions: [] }),
    ).toBeNull();
    expect(renderer.createNode({ actions: [action()] })).toBeNull();
  });
});
