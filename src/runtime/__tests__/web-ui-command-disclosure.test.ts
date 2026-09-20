import { describe, expect, test } from "vitest";
import { createConversationToolEvidence } from "../../web-ui/app/components/conversation-tool-evidence.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { createConversationTools } from "../../web-ui/app/components/conversation-tools.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { ContextElement } from "./support/composer-context-window-dom.js";
import { systemDisplayEvents } from "./support/system-tool-display-fixture.js";

function render(events: Record<string, unknown>[]) {
  const documentRoot = {
    createElement: (tag: string) =>
      Object.assign(new ContextElement(tag), { open: false, title: "" }),
  } as unknown as Document;
  const actions = buildConversationToolActions({
    requestId: "display-request",
    events,
    streaming: false,
  });
  const renderer = createConversationTools({ documentRoot });
  return renderer.createNode({ requestId: "display-request", actions })!;
}

describe("recorded command disclosure", () => {
  test("shared approval evidence keeps the target and exact prepared command visible", () => {
    const event = {
      ...systemDisplayEvents()[0]!,
      name: "tool.approval.required",
    };
    const evidence = projectToolActivityEvent(event)!;
    const documentRoot = {
      createElement: (tag: string) => new ContextElement(tag),
    } as unknown as Document;
    const node = createConversationToolEvidence(
      { ...evidence, executed: false },
      { documentRoot },
    )!;
    expect(node.textContent).toContain("windows");
    expect(node.querySelector(".conversation-tool-preview")!.textContent).toBe(
      "Get-Command ExampleApp",
    );
    expect(node.textContent).toContain("Prepared command");
    expect(node.textContent).not.toContain("Sent command");
    expect(
      createConversationToolEvidence(
        { sent: [], received: [], target: "", preview: "", executed: false },
        { documentRoot },
      ),
    ).toBeNull();
  });

  test("renders every command character as inert preformatted text apart from intent", () => {
    const command = ` \n<script>throw new Error('must stay inert')</script>\n${"x".repeat(3_900)}\n `;
    const node = render(systemDisplayEvents({ command }));
    const preview = node.querySelector(".conversation-tool-preview")!;
    expect(preview.tagName).toBe("pre");
    expect(preview.textContent).toBe(command);
    expect(preview.children.length).toBe(0);
    expect(node.querySelector("script")).toBeNull();
    expect(node.textContent).toContain("Sent command");
    expect(node.querySelector(".conversation-tool-intent")!.textContent).toBe(
      "Model-authored rationale",
    );
  });

  test("rejected commands are labelled prepared and do not imply execution", () => {
    const started = systemDisplayEvents()[0]!;
    const node = render([
      {
        ...started,
        name: "tool.failed",
        stage: "before_external_execution",
        error: "Approval rejected",
      },
    ]);
    expect(node.textContent).toContain("Prepared command");
    expect(node.textContent).not.toContain("Sent command");
    expect(node.textContent).not.toContain("Exit code");
  });

  test("legacy input is visibly unavailable without rendering opaque strings as a command", () => {
    const started = systemDisplayEvents()[0]!;
    const node = render([
      {
        ...started,
        name: "tool.completed",
        ok: true,
        meta: { params: { command: "string(len=22)" }, exitCode: 0 },
      },
    ]);
    expect(node.textContent).toContain("Not recorded in this event");
    expect(node.textContent).not.toContain("string(len=");
    expect(node.querySelector(".conversation-tool-preview")).toBeNull();
  });
});
