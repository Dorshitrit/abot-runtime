import { describe, expect, test, vi } from "vitest";
import {
  createToolApprovalCard,
  type ToolApprovalEvent,
} from "../../web-ui/app/components/tool-approval-card.js";
import { createToolApprovalController } from "../../web-ui/app/controllers/tool-approval-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { captureApprovalRejectionFocus } from "../../web-ui/app/components/tool-approval-rejection-input.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { createDashboardApprovalsController } from "../../web-ui/app/controllers/dashboard-approvals-controller.js";
// @ts-expect-error Browser-only module has no declaration surface.
import { renderDashboardApprovals } from "../../web-ui/app/components/dashboard/approvals.js";
import {
  ApprovalRejectionDocument,
  ApprovalRejectionElement,
  rejectionButton,
  rejectionInput,
} from "./support/approval-rejection-dom.js";

const event = {
  name: "tool.approval.required",
  eventName: "tool.approval.required",
  sessionId: "session",
  requestId: "request",
  approvalId: "approval",
  generation: "generation",
  waitId: "wait",
  revision: 1,
  tool: "write_file",
};

function enterExplanation(root: ApprovalRejectionElement, text: string) {
  rejectionButton(root, "Reject with message").dispatch("click");
  const input = rejectionInput(root);
  input.value = text;
  input.dispatch("input");
  return input;
}

function chatFixture() {
  const documentRoot = new ApprovalRejectionDocument();
  const root = documentRoot.createElement("section");
  let environmentId = "prod";
  const state = {
    connected: true,
    currentSessionId: "session",
    events: [{ ...event }] as ToolApprovalEvent[],
    submittedToolApprovalIds: new Set<string>(),
  };
  const sendRealtime = vi.fn(() => true);
  const controller = createToolApprovalController({
    state,
    selectedEnvironmentId: () => environmentId,
    sendRealtime,
    recordControlEvent: vi.fn(),
    renderMessages: render,
    createCard: (options) =>
      createToolApprovalCard({
        ...options,
        documentRoot: documentRoot as unknown as Document,
      }),
  });
  function render() {
    const restoreFocus = captureApprovalRejectionFocus(root, documentRoot);
    const events = controller.pendingEvents();
    root.replaceChildren(
      ...events.map(
        (pending) =>
          controller.createCard(pending) as unknown as ApprovalRejectionElement,
      ),
    );
    restoreFocus();
  }
  render();
  return {
    root,
    documentRoot,
    state,
    controller,
    sendRealtime,
    render,
    setEnvironment: (id: string) => {
      environmentId = id;
    },
  };
}

const focusButtons = [
  "Reject and send message",
  "Cancel",
  "Reject with message",
];

function focusRejectionButton(root: ApprovalRejectionElement, label: string) {
  enterExplanation(root, "Choose another target.");
  const button = rejectionButton(root, label);
  if (label === "Reject with message") {
    rejectionButton(root, "Cancel").dispatch("click");
    return button;
  }
  button.focus();
  return button;
}

describe("approval rejection explanation input", () => {
  test.each(focusButtons)(
    "Chat preserves %s focus across a rebuild",
    (label) => {
      const f = chatFixture();
      const previous = focusRejectionButton(f.root, label);
      expect(f.documentRoot.activeElement).toBe(previous);
      f.render();
      const restored = rejectionButton(f.root, label);
      expect(restored).not.toBe(previous);
      expect(f.documentRoot.activeElement).toBe(restored);
      expect(
        f.root.querySelector(".tool-approval-rejection-editor")?.hidden,
      ).toBe(label === "Reject with message");
      expect(f.sendRealtime).not.toHaveBeenCalled();
    },
  );

  test.each(focusButtons)(
    "Home preserves %s focus when its card is recreated",
    (label) => {
      const documentRoot = new ApprovalRejectionDocument();
      const root = documentRoot.createElement("section");
      const onDecision = vi.fn();
      const options = {
        root,
        documentRoot,
        onDecision,
        snapshot: {
          approvals: [
            {
              ...event,
              environmentId: "prod",
              event,
              rejectionDraft: { text: "", expanded: false },
            },
          ],
          sessions: [{ id: "session", title: "Original title" }],
        },
      };
      renderDashboardApprovals(options);
      const previous = focusRejectionButton(root, label);
      expect(documentRoot.activeElement).toBe(previous);
      renderDashboardApprovals({
        ...options,
        snapshot: {
          ...options.snapshot,
          sessions: [{ id: "session", title: "Changed title" }],
        },
      });
      const restored = rejectionButton(root, label);
      expect(restored).not.toBe(previous);
      expect(documentRoot.activeElement).toBe(restored);
      expect(
        root.querySelector(".tool-approval-rejection-editor")?.hidden,
      ).toBe(label === "Reject with message");
      expect(onDecision).not.toHaveBeenCalled();
    },
  );

  test.each(
    focusButtons.flatMap((label) =>
      ["removed", "new scope", "disabled"].map((change) => ({ label, change })),
    ),
  )(
    "does not restore $label after its approval is $change",
    ({ label, change }) => {
      const f = chatFixture();
      focusRejectionButton(f.root, label);
      if (change === "removed") f.state.events = [];
      if (change === "new scope") f.setEnvironment("another-environment");
      if (change === "disabled")
        f.state.submittedToolApprovalIds.add(event.approvalId);
      f.render();
      expect(f.documentRoot.activeElement).toBeNull();
      expect(f.sendRealtime).not.toHaveBeenCalled();
    },
  );

  test("keeps ordinary decisions unchanged and requires nonempty user text for the third action", () => {
    const documentRoot = new ApprovalRejectionDocument();
    const onDecision = vi.fn();
    const root = createToolApprovalCard({
      event,
      onDecision,
      documentRoot: documentRoot as unknown as Document,
    }) as unknown as ApprovalRejectionElement;
    rejectionButton(root, "Approve").dispatch("click");
    rejectionButton(root, "Reject").dispatch("click");
    expect(onDecision.mock.calls).toEqual([
      ["approval", true],
      ["approval", false],
    ]);
    onDecision.mockClear();

    const input = enterExplanation(root, " \n ");
    expect(documentRoot.activeElement).toBe(input);
    expect(rejectionButton(root, "Reject and send message").disabled).toBe(
      true,
    );
    rejectionButton(root, "Reject and send message").dispatch("click");
    expect(onDecision).not.toHaveBeenCalled();
    const explanation =
      "  אל תכתוב לקובץ הזה.\n<script>Use another target</script>  ";
    input.value = explanation;
    input.dispatch("input");
    expect(
      input.getAttribute("dir") ?? (input as unknown as { dir: string }).dir,
    ).toBe("auto");
    rejectionButton(root, "Reject and send message").dispatch("click");
    const [approvalId, approved, reason] = onDecision.mock.calls[0]!;
    expect([approvalId, approved]).toEqual(["approval", false]);
    expect(reason).not.toBe(explanation.trim());
    expect(reason.endsWith("\n" + explanation.trim())).toBe(true);
    expect(reason.split(explanation.trim())).toHaveLength(2);
    expect(root.querySelector("script")).toBeNull();
    rejectionButton(root, "Cancel").dispatch("click");
    expect(root.querySelector(".tool-approval-rejection-editor")?.hidden).toBe(
      true,
    );
    rejectionButton(root, "Reject with message").dispatch("click");
    expect(rejectionInput(root).value).toBe(explanation);
  });

  test("Chat keeps typed text, selection and focus through rebuilds and a definite send failure", () => {
    const f = chatFixture();
    const input = enterExplanation(f.root, "Choose a read-only alternative.");
    input.setSelectionRange(3, 9, "backward");
    input.scrollTop = 12;
    f.render();
    const restored = rejectionInput(f.root);
    expect(restored).not.toBe(input);
    expect(restored.value).toBe(input.value);
    expect(f.documentRoot.activeElement).toBe(restored);
    expect([
      restored.selectionStart,
      restored.selectionEnd,
      restored.selectionDirection,
    ]).toEqual([3, 9, "backward"]);
    expect(restored.scrollTop).toBe(12);

    f.sendRealtime.mockReturnValueOnce(false);
    rejectionButton(f.root, "Reject and send message").dispatch("click");
    expect(f.state.submittedToolApprovalIds.size).toBe(0);
    expect(rejectionInput(f.root).value).toBe(input.value);
    expect(rejectionInput(f.root).disabled).toBe(false);
    const firstReason = (
      f.sendRealtime.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0].reason;
    rejectionButton(f.root, "Reject and send message").dispatch("click");
    const sent = (
      f.sendRealtime.mock.calls[1] as unknown as [Record<string, unknown>]
    )[0];
    expect(sent).toMatchObject({
      type: "tool_approval_response",
      approved: false,
      environment: "prod",
      sessionId: event.sessionId,
      requestId: event.requestId,
      generation: event.generation,
      waitId: event.waitId,
      revision: event.revision,
      reason: firstReason,
    });
    expect(rejectionInput(f.root).disabled).toBe(true);
    rejectionButton(f.root, "Reject and send message").dispatch("click");
    expect(f.sendRealtime).toHaveBeenCalledTimes(2);
    expect(f.controller.submit(event.approvalId, false, "changed")).toBe(false);
    expect(sent.reason).toBe(firstReason);
  });

  test("Chat retains the same draft and focus when a live approval becomes a saved wait", () => {
    const f = chatFixture();
    const {
      generation: _generation,
      waitId: _waitId,
      revision: _revision,
      ...live
    } = event;
    f.state.events = [live];
    f.render();
    const input = enterExplanation(
      f.root,
      "Keep this text while the remaining work settles.",
    );
    input.setSelectionRange(5, 13);
    f.state.events = [{ ...event }];
    f.render();
    expect(rejectionInput(f.root).value).toBe(input.value);
    expect(f.documentRoot.activeElement).toBe(rejectionInput(f.root));
    expect(rejectionInput(f.root).selectionStart).toBe(5);
    rejectionButton(f.root, "Reject and send message").dispatch("click");
    expect(f.sendRealtime).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: event.generation,
        waitId: event.waitId,
        approved: false,
      }),
    );
  });

  test("old Chat controls cannot send into another environment or approval generation", () => {
    const f = chatFixture();
    enterExplanation(f.root, "This explanation belongs to prod.");
    const oldSend = rejectionButton(f.root, "Reject and send message");
    f.setEnvironment("dev");
    f.render();
    expect(rejectionInput(f.root).value).toBe("");
    oldSend.dispatch("click");
    expect(f.sendRealtime).not.toHaveBeenCalled();
    enterExplanation(f.root, "A different explanation.");
    const previousGeneration = rejectionButton(
      f.root,
      "Reject and send message",
    );
    f.state.events = [
      { ...event, generation: "new-generation", waitId: "new-wait" },
    ];
    f.render();
    expect(rejectionInput(f.root).value).toBe("");
    previousGeneration.dispatch("click");
    expect(f.sendRealtime).not.toHaveBeenCalled();
  });

  test("Home retains explanation and focus across refreshed card content and failed submission", async () => {
    const documentRoot = new ApprovalRejectionDocument();
    const root = documentRoot.createElement("section");
    const pending = {
      environmentId: "prod",
      sessionId: event.sessionId,
      requestId: event.requestId,
      approvalId: event.approvalId,
      generation: event.generation,
      waitId: event.waitId,
      revision: event.revision,
      event,
    };
    let fail!: (reason: Error) => void;
    let title = "Original conversation";
    const client = {
      supportsToolApprovals: () => true,
      listToolApprovals: vi.fn(async () => ({ approvals: [pending] })),
      decideToolApproval: vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      ),
    };
    const controller = createDashboardApprovalsController({
      client,
      getEnvironmentId: () => "prod",
      render,
    });
    function render() {
      renderDashboardApprovals({
        root,
        documentRoot,
        onDecision: controller.submit,
        snapshot: {
          ...controller.snapshot(),
          sessions: [{ id: "session", title }],
        },
      });
    }
    await controller.refresh();
    const input = enterExplanation(root, "Do not overwrite the original.");
    input.setSelectionRange(4, 10);
    title = "Renamed conversation";
    render();
    expect(rejectionInput(root)).not.toBe(input);
    expect(rejectionInput(root).value).toBe(input.value);
    expect(documentRoot.activeElement).toBe(rejectionInput(root));
    expect(rejectionInput(root).selectionStart).toBe(4);

    rejectionButton(root, "Reject and send message").dispatch("click");
    expect(client.decideToolApproval).toHaveBeenCalledOnce();
    expect(rejectionInput(root).disabled).toBe(true);
    rejectionButton(root, "Reject and send message").dispatch("click");
    expect(client.decideToolApproval).toHaveBeenCalledOnce();
    const captured = (
      client.decideToolApproval.mock.calls[0] as unknown as [
        Record<string, unknown>,
      ]
    )[0];
    expect(captured).toMatchObject({
      approved: false,
      environmentId: "prod",
      approvalId: event.approvalId,
      sessionId: event.sessionId,
      requestId: event.requestId,
    });
    expect(String(captured.reason).endsWith(input.value)).toBe(true);
    fail(new Error("Decision unavailable"));
    await vi.waitFor(() => expect(rejectionInput(root).disabled).toBe(false));
    expect(rejectionInput(root).value).toBe(input.value);
    expect(controller.snapshot().approvalDecisionError).toBe(
      "Decision unavailable",
    );
    controller.invalidate();
    await controller.refresh();
    expect(rejectionInput(root).value).toBe("");
  });
});
