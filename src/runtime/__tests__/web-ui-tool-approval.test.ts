import { describe, expect, test, vi } from "vitest";

import { createToolApprovalCard } from "../../web-ui/app/components/tool-approval-card.js";
import { createToolApprovalController } from "../../web-ui/app/controllers/tool-approval-controller.js";
import { formatEventDetail } from "../../web-ui/app/lib/event-presentation.js";

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
  test("renders the latest unresolved approval and submits one exact decision", () => {
    const state = {
      connected: true,
      events: [
        {
          eventName: "tool.approval.required",
          approvalId: "approval-1",
          tool: "write_file",
          summary: "Write the requested file",
        },
      ],
      submittedToolApprovalIds: new Set<string>(),
    };
    const sendRealtime = vi.fn(() => true);
    const renderMessages = vi.fn();
    const createCard = vi.fn((input) =>
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
