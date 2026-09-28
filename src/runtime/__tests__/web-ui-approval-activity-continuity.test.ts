import { expect, test, vi } from "vitest";
import { createToolApprovalController } from "../../web-ui/app/controllers/tool-approval-controller.js";
import { buildConversationRoleCards } from "../../web-ui/app/lib/conversation-role-model.js";
import { buildConversationToolActions } from "../../web-ui/app/lib/tool-activity-model.js";
import { buildConversationStatus } from "../../web-ui/app/lib/conversation-status-model.js";
import { createPlanLifecycleHarness } from "./support/web-ui-plan-lifecycle-harness.js";
import {
  accepted,
  activationExpected,
  fixture,
  waitExpected,
} from "../../sessions/request-lifecycle/__tests__/support.js";

test("partial and successive saved approvals keep the remaining card and one row per action", async () => {
  const f = await fixture(2);
  const approvals = f.approvals.map((approval, index) => ({
    ...approval,
    presentation: {
      ...approval.presentation,
      executionId: `execution-${index + 1}`,
      executorRole: "worker",
      roleCallId: "call-2",
    },
  }));
  const harness = createPlanLifecycleHarness();
  const state = Object.assign(harness.state, { connected: true });
  state.currentSessionId = "conversation";
  state.activeRequestId = "request";
  state.messages = [
    { id: "user", role: "user", requestId: "request", text: "Inspect targets" },
  ];
  const controller = createToolApprovalController({
    state,
    selectedEnvironmentId: () => "dev",
    sendRealtime: harness.sendRealtime,
    renderMessages: harness.renderMessages,
    recordControlEvent: vi.fn(),
    createCard: vi.fn(),
  });
  function deliver(result: ReturnType<typeof accepted>) {
    result.events.forEach(harness.realtime.handle);
    return result.current;
  }
  let current = deliver(
    accepted(
      await f.service.requestLifecycle.commitWait("conversation", {
        ...f.command,
        approvals,
      }),
    ),
  );
  expect(controller.pendingEvents().map((event) => event.approvalId)).toEqual([
    "approval-1",
    "approval-2",
  ]);
  current = deliver(
    accepted(
      await f.service.requestLifecycle.commitDecision("conversation", {
        expected: waitExpected(current),
        approvalId: "approval-1",
        commandId: "first",
        approved: false,
      }),
    ),
  );
  expect(controller.pendingEvents().map((event) => event.approvalId)).toEqual([
    "approval-2",
  ]);
  expect(
    buildConversationRoleCards({
      requestId: "request",
      events: state.events,
    })[0]?.toolActions?.map((action) => action.statusLabel),
  ).toEqual(["Not approved", "Awaiting approval"]);
  current = deliver(
    accepted(
      await f.service.requestLifecycle.commitDecision("conversation", {
        expected: waitExpected(current),
        approvalId: "approval-2",
        commandId: "second",
        approved: false,
        resumeActivation: {
          ownerEpoch: "owner-1",
          activationId: "activation-2",
        },
      }),
    ),
  );
  expect(controller.pendingEvents()).toEqual([]);
  expect(buildConversationStatus({ requestId: "request", streaming: true, events: state.events })?.label).toBe("Working");
  current = deliver(
    accepted(
      await f.service.requestLifecycle.commitWait("conversation", {
        ...f.command,
        expected: activationExpected(current),
        waitId: "wait-2",
        continuation: await f.service.requestLifecycle.writeContinuation(
          "conversation",
          {
            schema: f.continuation.schema,
            version: f.continuation.version,
            value: { exactAction: "next action", previousResult: "declined" },
          },
        ),
        approvals: [
          {
            ...approvals[0]!,
            approvalId: "approval-3",
            actionFingerprint: "action-3",
            presentation: {
              ...approvals[0]!.presentation,
              executionId: "execution-3",
            },
          },
        ],
      }),
    ),
  );
  expect(controller.pendingEvents().map((event) => event.approvalId)).toEqual([
    "approval-3",
  ]);
  const cards = buildConversationRoleCards({
    requestId: "request",
    events: state.events,
  });
  expect(cards).toHaveLength(1);
  expect(cards[0]?.role).toBe("worker");
  expect(cards[0]?.toolActions?.map((action) => action.statusLabel)).toEqual([
    "Not approved",
    "Not approved",
    "Awaiting approval",
  ]);
  expect(state.activeRequestId).toBe("");
  expect(current.wait?.approvals).toHaveLength(1);
});

test("older saved decisions bind by approval identity and terminal requests close unresolved rows", () => {
  const required = (executionId: string, approvalId: string) => ({
    requestId: "request",
    name: "tool.approval.required",
    tool: "web_search",
    executionId,
    approvalId,
  });
  const events = [
    required("one", "a"),
    {
      requestId: "request",
      name: "tool.approval.rejected",
      tool: "web_search",
      approvalId: "a",
    },
    required("two", "b"),
  ];
  const original = structuredClone(events);
  const actions = buildConversationToolActions({
    requestId: "request",
    events,
  });
  expect(actions.map((action) => action.statusLabel)).toEqual([
    "Not approved",
    "Awaiting approval",
  ]);
  expect(actions.every((action) => !action.executed)).toBe(true);
  expect(events).toEqual(original);
  expect(buildConversationStatus({ requestId: "request", streaming: true, events: events.slice(0, 2) })?.label).toBe("Working");
  expect(
    buildConversationRoleCards({ requestId: "request", events }).flatMap(
      (card) => card.toolActions,
    ),
  ).toHaveLength(2);
  expect(
    buildConversationToolActions({
      requestId: "request",
      events: [...events, { requestId: "request", type: "failed" }],
    })[1]?.status,
  ).toBe("incomplete");
  expect(
    buildConversationToolActions({
      requestId: "request",
      events: [events[0]!, { ...events[1]!, requestId: "other" }],
    })[0]?.status,
  ).toBe("awaiting_approval");
});
