import { describe, expect, test, vi } from "vitest";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";

import {
  createToolApprovalCard,
  type ToolApprovalCardOptions,
  type ToolApprovalEvent,
} from "../../web-ui/app/components/tool-approval-card.js";
import { createToolApprovalController } from "../../web-ui/app/controllers/tool-approval-controller.js";
import { formatEventDetail } from "../../web-ui/app/lib/event-presentation.js";
import { projectToolActivityEvent } from "../../web-ui/app/lib/tool-activity-event.js";
import { ContextElement } from "./support/composer-context-window-dom.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Array<() => void>>();
  className = "";
  textContent = "";
  dir = "";
  type = "";
  disabled = false;
  readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  addEventListener(name: string, listener: () => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }
}

function fakeDocument(): Document {
  return {
    createElement: (tagName: string) =>
      new FakeElement(tagName.toUpperCase()) as unknown as HTMLElement,
  } as unknown as Document;
}

describe("web ui tool approval controller", () => {
  test("approval discloses the bound computer and command before execution", () => {
    const computerName = "Owner <script>computer</script>";
    const toolActivity = projectToolActivityEvent({
      name: "tool.approval.required",
      tool: "system_command",
      meta: {
        computerName,
        displayTarget: "windows",
        command: "Get-Date",
        commandTruncated: false,
      },
    })!;
    const card = createToolApprovalCard({
      event: {
        approvalId: "host-action",
        tool: "system_command",
        toolActivity,
      },
      onDecision: vi.fn(),
      documentRoot: {
        createElement: (tag: string) => new ContextElement(tag),
      } as unknown as Document,
    });
    expect(card.textContent).toContain("Computer");
    expect(card.textContent).toContain(computerName);
    expect(card.textContent).toContain("Prepared command");
    expect(card.textContent).toContain("Get-Date");
    expect(card.querySelector("script")).toBeNull();
  });

  test("renders the latest unresolved approval and submits one exact decision", () => {
    const events: ToolApprovalEvent[] = [
      {
        eventName: "tool.approval.required",
        approvalId: "approval-1",
        tool: "write_file",
        summary: "Write the requested file",
      },
    ];
    const state = {
      connected: true,
      events,
      submittedToolApprovalIds: new Set<string>(),
    };
    const sendRealtime = vi.fn(() => true);
    const renderMessages = vi.fn();
    const createCard = vi.fn((input: ToolApprovalCardOptions) =>
      createToolApprovalCard({
        ...input,
        documentRoot: fakeDocument(),
      }),
    );
    const controller = createToolApprovalController({
      state,
      selectedEnvironmentId: () => "dev",
      sendRealtime,
      renderMessages,
      recordControlEvent: vi.fn(),
      createCard,
    });

    const pending = controller.pendingEvent();
    expect(pending).toMatchObject({ approvalId: "approval-1" });
    const row = controller.createCard(pending) as unknown as FakeElement;
    const bubble = row.children[0]!;
    const actions = bubble.children[2]!;
    const approveButton = actions.children[0]!;
    const header = bubble.children[0]!;
    const detail = bubble.children[1]!;
    expect(row.className).toBe("message-row assistant approval-message-row");
    expect(header.children[0]?.textContent).toBe("Approval required");
    expect(header.children[1]?.textContent).toBe("Allow file writer to run?");
    expect(detail.textContent).toBe("Write the requested file");
    expect(detail.dir).toBe("auto");
    expect(approveButton.disabled).toBe(false);
    expect(createCard).toHaveBeenCalledWith(
      expect.objectContaining({
        event: pending,
        submitted: false,
        onDecision: expect.any(Function),
      }),
    );

    approveButton.dispatch("click");
    expect(sendRealtime).toHaveBeenCalledWith({
      type: "tool_approval_response",
      approvalId: "approval-1",
      approved: true,
      environment: "dev",
    });
    expect(state.submittedToolApprovalIds.has("approval-1")).toBe(true);
    expect(renderMessages).toHaveBeenCalledTimes(1);

    state.events.push({
      eventName: "tool.approval.granted",
      approvalId: "approval-1",
    });
    expect(controller.pendingEvent()).toBeUndefined();
  });

  test("presents only the action intent in approval details", () => {
    expect(
      formatEventDetail({
        name: "tool.approval.required",
        tool: "write_file",
        meta: { intent: "Write the requested file" },
        message: "file writer: Waiting for approval",
      }),
    ).toBe("Write the requested file");
    expect(
      formatEventDetail({
        name: "tool.approval.required",
        tool: "write_file",
        message: "file writer: Waiting for approval",
      }),
    ).toBe("Review this action before it runs.");
  });

  test("keeps approval pending when realtime is disconnected", () => {
    const state = {
      connected: false,
      events: [],
      submittedToolApprovalIds: new Set<string>(),
    };
    const recordControlEvent = vi.fn();
    const sendRealtime = vi.fn();
    const controller = createToolApprovalController({
      state,
      selectedEnvironmentId: () => "dev",
      sendRealtime,
      renderMessages: vi.fn(),
      recordControlEvent,
      createCard: vi.fn(),
    });

    expect(controller.submit("approval-2", false)).toBe(false);
    expect(sendRealtime).not.toHaveBeenCalled();
    expect(state.submittedToolApprovalIds).not.toContain("approval-2");
    expect(recordControlEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Approval failed",
        tone: "failed",
      }),
    );
  });
});

function descendantElements(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(descendantElements)];
}

test("approval keeps command evidence and recommendation through live projection and replay", async () => {
  const event = {
    type: "event",
    name: "tool.approval.required",
    requestId: "request-1",
    sessionId: "session-1",
    eventSequence: 9,
    approvalId: "system-approval",
    tool: "system_command",
    recommendedToolPermissionMode: "full_plus",
    meta: {
      intent: "Run the requested action",
      command: "  printf '<unsafe>'\nnext",
      commandTruncated: false,
      displayTarget: "linux",
      cwd: "/selected/workspace",
      elevated: true,
    },
  };
  const live = createPlanLifecycleHarness();
  live.realtime.recordEvent(event);
  const replay = createPlanLifecycleHarness({
    sessionId: "session-1",
    messages: [],
    requests: [
      {
        requestId: "request-1",
        status: "running",
        events: [{ ...event, seqNo: 1, timestamp: 1000 }],
      },
    ],
  });
  await replay.conversationSession.openSession("session-1");
  for (const state of [live.state, replay.state]) {
    const projected = state.events[0]!;
    expect(projected.recommendedToolPermissionMode).toBe("full_plus");
    const decision = vi.fn();
    const card = createToolApprovalCard({
      event: projected,
      onDecision: decision,
      documentRoot: fakeDocument(),
    }) as unknown as FakeElement;
    const all = descendantElements(card);
    expect(all.some((node) => node.textContent === "linux")).toBe(true);
    expect(all.some((node) => node.textContent === "/selected/workspace")).toBe(
      true,
    );
    expect(all.some((node) => node.textContent === "Elevated")).toBe(true);
    expect(all.some((node) => node.textContent === "Yes")).toBe(true);
    expect(all.find((node) => node.tagName === "PRE")?.textContent).toBe(
      event.meta.command,
    );
    expect(all.some((node) => node.textContent.includes("select FULL+"))).toBe(
      true,
    );
    expect(
      all.some((node) => node.textContent.includes("keeps your current mode")),
    ).toBe(true);
    expect(decision).not.toHaveBeenCalled();
    all
      .find(
        (node) => node.tagName === "BUTTON" && node.textContent === "Approve",
      )!
      .dispatch("click");
    expect(decision).toHaveBeenCalledWith("system-approval", true);
  }
});
