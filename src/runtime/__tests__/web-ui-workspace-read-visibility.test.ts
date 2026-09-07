import { describe, expect, test, vi } from "vitest";

// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
import { createConversationReadStateController } from "../../web-ui/app/controllers/conversation-read-state-controller.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

function createVisibilityHarness() {
  const navigation = createWorkspaceShellHarness(1259);
  const pendingReads: Array<() => void> = [];
  let documentVisible = true;
  const state = {
    currentSessionId: "chat-1",
    sessionViewVersion: 1,
    messages: [
      {
        id: "msg-2",
        role: "assistant",
        text: "Original answer",
        requestId: "request-1",
        streaming: false,
      },
    ],
  };
  const client = {
    markSessionRead: vi.fn(async () => ({ readState: { unreadCount: 0 } })),
  };
  let shell: ReturnType<typeof createWorkspaceShell>;
  const readState = createConversationReadStateController({
    state,
    client,
    selectedEnvironmentId: () => "dev",
    isConversationVisible: () =>
      shell.activeWorkspace() === "chat" &&
      !navigation.dom.chatPanel.inert &&
      documentVisible,
    applyReadState: vi.fn(),
    recordControlEvent: vi.fn(),
    scheduleTask: (callback) => pendingReads.push(callback),
  });
  const onWorkspaceChange = vi.fn(() => readState.markCurrentSessionReadSoon());
  shell = createWorkspaceShell({ ...navigation, onWorkspaceChange });
  shell.bind();
  shell.load();

  return {
    ...navigation,
    shell,
    state,
    client,
    readState,
    pendingReads,
    onWorkspaceChange,
    setDocumentVisible(value: boolean) {
      documentVisible = value;
    },
    addCompletedAnswer() {
      state.messages.push({
        id: "msg-4",
        role: "assistant",
        text: "Answer behind the drawer",
        requestId: "request-2",
        streaming: false,
      });
      readState.markCurrentSessionReadSoon();
    },
    async flushReads() {
      for (const callback of pendingReads.splice(0)) callback();
      await Promise.resolve();
    },
  };
}

async function openDrawerWithUnreadAnswer() {
  const harness = createVisibilityHarness();
  harness.shell.activateWorkspace("chat", { focus: false });
  await harness.flushReads();
  harness.client.markSessionRead.mockClear();
  harness.shell.setSessionsDrawerOpen(true, { focus: false });
  await harness.flushReads();
  harness.addCompletedAnswer();
  return harness;
}

describe("workspace drawer read visibility", () => {
  test.each(["close button", "backdrop", "Escape"])(
    "acknowledges a completed answer after the drawer closes through %s",
    async (closeAction) => {
      const harness = await openDrawerWithUnreadAnswer();
      expect(harness.dom.chatPanel.inert).toBe(true);
      expect(harness.client.markSessionRead).not.toHaveBeenCalled();

      if (closeAction === "close button")
        harness.dom.closeSessionsButton.dispatch("click");
      if (closeAction === "backdrop")
        harness.dom.panelBackdrop.dispatch("click");
      if (closeAction === "Escape") harness.shell.closeOverlaysOnEscape();
      expect(harness.dom.chatPanel.inert).toBe(false);
      await harness.flushReads();

      expect(harness.client.markSessionRead).toHaveBeenCalledOnce();
      expect(harness.client.markSessionRead).toHaveBeenCalledWith({
        environmentId: "dev",
        sessionId: "chat-1",
        readThroughMessageId: 4,
      });
    },
  );

  test("acknowledges the revealed answer when resizing changes the drawer into a docked sidebar", async () => {
    const harness = await openDrawerWithUnreadAnswer();

    harness.resize(1260);
    expect(harness.dom.chatPanel.inert).toBe(false);
    expect(harness.dom.sessionsPanel.hidden).toBe(false);
    await harness.flushReads();

    expect(harness.client.markSessionRead).toHaveBeenCalledWith({
      environmentId: "dev",
      sessionId: "chat-1",
      readThroughMessageId: 4,
    });
  });

  test("does not acknowledge a queued visible-Chat read after the drawer opens", async () => {
    const harness = createVisibilityHarness();
    harness.shell.activateWorkspace("chat", { focus: false });

    harness.shell.setSessionsDrawerOpen(true, { focus: false });
    await harness.flushReads();

    expect(harness.dom.chatPanel.inert).toBe(true);
    expect(harness.client.markSessionRead).not.toHaveBeenCalled();
  });

  test.each(["close", "resize"])(
    "does not acknowledge a revealed Chat while the document is hidden: %s",
    async (revealAction) => {
      const harness = await openDrawerWithUnreadAnswer();
      harness.setDocumentVisible(false);

      if (revealAction === "close") harness.shell.setSessionsDrawerOpen(false);
      if (revealAction === "resize") harness.resize(1260);
      await harness.flushReads();

      expect(harness.dom.chatPanel.inert).toBe(false);
      expect(harness.client.markSessionRead).not.toHaveBeenCalled();
    },
  );

  test.each(["home", "config", "schedules"])(
    "does not acknowledge the background Chat or notify an unchanged workspace on resize: %s",
    async (workspace) => {
      const harness = createVisibilityHarness();
      harness.shell.activateWorkspace(workspace, { focus: false });
      harness.onWorkspaceChange.mockClear();

      harness.resize(1260);
      await harness.flushReads();

      expect(harness.dom.chatPanel.hidden).toBe(true);
      expect(harness.onWorkspaceChange).not.toHaveBeenCalled();
      expect(harness.client.markSessionRead).not.toHaveBeenCalled();
    },
  );
});
