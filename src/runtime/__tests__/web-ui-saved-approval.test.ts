import { expect, test, vi } from "vitest";
import { createRequestLifecycleController } from "../../web-ui/app/controllers/request-lifecycle-controller.js";
import { createToolApprovalController } from "../../web-ui/app/controllers/tool-approval-controller.js";
import { createComposerStopController } from "../../web-ui/app/controllers/composer-stop-controller.js";
import { normalizeConversationMessage } from "../../web-ui/app/controllers/conversation-session-controller.js";
import {
  sameConversationMessage,
  projectApprovalContinuations,
} from "../../web-ui/app/lib/request-lifecycle-view.js";
import { ManagedWebToolApprovals } from "../../web-ui/local-runtime/managed-tool-approvals.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import { LocalRequestExecution } from "../../web-ui/local-runtime/request-execution.js";
import { RealtimeClientHub } from "../../web-ui/local-runtime/realtime-hub.js";

function lifecycle(revision = 1) {
  return {
    schemaVersion: 1,
    sessionId: "session",
    requestId: "request",
    generation: "generation",
    revision,
    status: "awaiting_approval",
    decisionReceipts: [],
    wait: {
      waitId: "wait",
      presentationMessageId: "approval-message",
      approvals: ["a", "b"].map((approvalId) => ({
        approvalId,
        actionFingerprint: approvalId,
        presentation: {
          tool: "fixture",
          call: { tool: "fixture", params: {} },
        },
      })),
    },
  };
}
function stateFixture() {
  return {
    currentSessionId: "session",
    activeRequestId: "request",
    connected: true,
    events: [],
    submittedToolApprovalIds: new Set(),
    requestMessages: new Map([["request", "temporary"]]),
    messages: [
      {
        id: "temporary",
        requestId: "request",
        role: "assistant",
        streaming: true,
      },
    ],
  };
}

test("approval, resumed streaming and final answer share one visible response without changing saved messages", () => {
  const user = {
    id: "user",
    role: "user",
    requestId: "request",
    text: "Find news.",
  };
  const approval = {
    id: "wait",
    role: "assistant",
    requestId: "request",
    kind: "tool_approval_request",
    text: "Finding news.",
    createdAt: 100,
  };
  const streaming = {
    id: "stream",
    role: "assistant",
    requestId: "request",
    text: "Here are",
    streaming: true,
    createdAt: 200,
  };
  const terminal = {
    ...streaming,
    id: "final",
    kind: "terminal",
    text: "Here are the articles.",
    streaming: false,
    createdAt: 300,
  };
  const nextWait = {
    ...approval,
    id: "next-wait",
    requestId: "other",
    createdAt: 400,
  };
  expect(projectApprovalContinuations([user, approval])).toEqual([
    user,
    approval,
  ]);
  expect(projectApprovalContinuations([user, approval, streaming])).toEqual([
    user,
    { ...streaming, createdAt: 100 },
  ]);
  const saved = [user, approval, terminal, nextWait];
  expect(projectApprovalContinuations(saved)).toEqual([
    user,
    { ...terminal, createdAt: 100 },
    nextWait,
  ]);
  expect(saved).toEqual([user, approval, terminal, nextWait]);
  expect(approval.text).toBe("Finding news.");
  expect(terminal.createdAt).toBe(300);
  const secondWait = {
    ...approval,
    id: "wait-2",
    text: "Reading another article.",
    createdAt: 250,
  };
  expect(
    projectApprovalContinuations([user, approval, streaming, secondWait]),
  ).toEqual([user, { ...secondWait, createdAt: 100 }]);
  expect(projectApprovalContinuations([user, terminal])).toEqual([
    user,
    terminal,
  ]);
});

test("a saved response removes the running row, renders the complete approval group and keeps stable decision identity", () => {
  const state = stateFixture();
  const renderMessages = vi.fn();
  const onLifecycle = createRequestLifecycleController({
    state,
    renderMessages,
    normalizeChatMessage: normalizeConversationMessage,
    addOrMergeMessage: (message: any) => {
      state.messages.push(message);
    },
    activeAssistantForRequest: vi.fn(),
    updateComposerSendState: vi.fn(),
    setMessageActivityStatus: vi.fn(),
    markCurrentSessionReadSoon: vi.fn(),
    cancelScheduledMessageRender: vi.fn(),
    cancelScheduledThinkingRender: vi.fn(),
  });
  const current = lifecycle();
  onLifecycle.handle({
    name: "request.lifecycle.changed",
    lifecycle: current,
    message: {
      id: "approval-message",
      requestId: "request",
      role: "assistant",
      content: "Approval needed.",
      kind: "tool_approval_request",
      approvalRequest: {
        state: "pending",
        approvals: current.wait.approvals,
        decisions: [],
      },
    },
  });
  expect(state.activeRequestId).toBe("");
  expect(state.messages.map((message) => message.id)).toEqual([
    "approval-message",
  ]);
  const sendRealtime = vi.fn((_message: Record<string, unknown>) => true);
  const approval = createToolApprovalController({
    state,
    renderMessages,
    sendRealtime,
    selectedEnvironmentId: () => "dev",
    recordControlEvent: vi.fn(),
    createCard: vi.fn(),
  } as any);
  expect(approval.pendingEvents()).toHaveLength(2);
  expect(approval.submit("a", true)).toBe(true);
  expect(sendRealtime).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "request",
      sessionId: "session",
      generation: "generation",
      waitId: "wait",
      revision: 1,
    }),
  );
  const command = sendRealtime.mock.calls[0]![0] as any;
  state.submittedToolApprovalIds.clear();
  approval.submit("a", true);
  expect((sendRealtime.mock.calls[1]![0] as any).commandId).toBe(
    command.commandId,
  );
  expect(
    sameConversationMessage(state.messages[0], {
      id: "terminal",
      role: "assistant",
      requestId: "request",
      persistedMessageId: "terminal",
    }),
  ).toBe(false);
});

test("Stop targets the saved wait without inventing an active request", async () => {
  const state = {
    ...stateFixture(),
    activeRequestId: "",
    requestLifecycles: new Map([["request", lifecycle()]]),
  };
  const stopRequest = vi.fn(async () => ({ accepted: true }));
  const controller = createComposerStopController({
    state,
    selectedEnvironmentId: () => "dev",
    stopRequest,
    updateSendState: vi.fn(),
    setMessageStatus: vi.fn(),
  });
  await controller.stop();
  expect(stopRequest).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "request",
      sessionId: "session",
      generation: "generation",
      waitId: "wait",
      revision: 1,
    }),
  );
  expect(state.activeRequestId).toBe("");
});

test("Web lists saved metadata and decides without attaching a live execution", async () => {
  const entry = {
    sessionId: "session",
    wait: { generation: "generation", waitId: "wait", revision: 1 },
    request: {
      requestId: "request",
      approvalId: "a",
      call: { tool: "fixture", params: {} },
    },
  };
  const event = {
    name: "tool.approval.required",
    requestId: "request",
    approvalId: "a",
  };
  const environment = {
    approvals: {
      list: vi.fn(async () => [entry]),
      decide: vi.fn(async () => ({ accepted: true })),
      attach: vi.fn(),
    },
    services: {
      sessions: {
        getRequestReplayById: vi.fn(async () => ({
          sessionId: "session",
          events: [event],
        })),
      },
    },
  };
  const requests = new LocalRequestExecution(new RealtimeClientHub());
  const managed = new ManagedWebToolApprovals(
    () => environment as unknown as RuntimeEnvironment,
    requests,
  );
  const [approval] = await managed.list("dev");
  expect(approval).toMatchObject(entry.wait);
  expect(
    await managed.decide({ ...approval!, approved: true, commandId: "choice" }),
  ).toBe(true);
  expect(environment.approvals.attach).not.toHaveBeenCalled();
  expect(requests.healthDetails()).toEqual([]);
  expect(environment.approvals.decide).toHaveBeenCalledWith(
    expect.objectContaining({ ...entry.wait, commandId: "choice" }),
  );
});
