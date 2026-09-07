import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
import {
  createWorkspaceShellHarness,
  isAvailableWorkspaceFocus,
} from "./support/workspace-shell-harness.js";

type WorkspaceChange = { from: string; to: string };
type WorkspaceGuard = (
  change: WorkspaceChange,
) => boolean | null | (() => void);

function createNavigation(
  width = 1259,
  beforeWorkspaceChange: WorkspaceGuard = () => true,
  options: { matchMedia?: boolean; evictHiddenFocus?: boolean } = {},
) {
  const harness = createWorkspaceShellHarness(width, options);
  const shell = createWorkspaceShell({ ...harness, beforeWorkspaceChange });
  shell.bind();
  shell.load();
  shell.activateWorkspace("chat", { focus: false });
  return { ...harness, shell };
}

function expectBackdropHidden(
  dom: ReturnType<typeof createWorkspaceShellHarness>["dom"],
) {
  expect(dom.panelBackdrop.classList.contains("visible")).toBe(false);
  expect(dom.panelBackdrop.getAttribute("aria-hidden")).toBe("true");
  expect(dom.panelBackdrop.tabIndex).toBe(-1);
}

function expectDockedChat(
  dom: ReturnType<typeof createWorkspaceShellHarness>["dom"],
) {
  expect(dom.chatPanel.hidden).toBe(false);
  expect(dom.chatPanel.inert).toBe(false);
  expect(dom.sessionsPanel.hidden).toBe(false);
  expect(dom.sessionsPanel.inert).toBe(false);
  expect(dom.sessionsPanel.getAttribute("aria-hidden")).toBe("false");
  expect(dom.sessionsToggleButton.hidden).toBe(true);
  expect(dom.closeSessionsButton.hidden).toBe(true);
  expectBackdropHidden(dom);
}

function expectConfigWithoutSessions(
  dom: ReturnType<typeof createWorkspaceShellHarness>["dom"],
) {
  expect(dom.configWorkspacePanel.hidden).toBe(false);
  expect(dom.configWorkspacePanel.inert).toBe(false);
  expect(dom.chatPanel.hidden).toBe(true);
  expect(dom.sessionsPanel.hidden).toBe(true);
  expect(dom.sessionsPanel.inert).toBe(true);
  expect(dom.sessionsPanel.getAttribute("aria-hidden")).toBe("true");
  expect(dom.sessionsToggleButton.hidden).toBe(true);
  expect(dom.chatWorkspaceButton.hidden).toBe(false);
  expectBackdropHidden(dom);
}

describe("responsive workspace navigation", () => {
  test("starts on Home and keeps conversation reading behind explicit Chat navigation", () => {
    const harness = createWorkspaceShellHarness(1440);
    const onWorkspaceChange = vi.fn();
    const shell = createWorkspaceShell({ ...harness, onWorkspaceChange });
    shell.bind();
    shell.load();
    expect(shell.activeWorkspace()).toBe("home");
    expect(harness.dom.homeWorkspacePanel.hidden).toBe(false);
    expect(harness.dom.chatPanel.hidden).toBe(true);
    expect(harness.dom.chatPanel.inert).toBe(true);
    expect(harness.dom.sessionsPanel.hidden).toBe(true);
    expect(shell.closeOverlaysOnEscape()).toBe(false);
    harness.dom.chatWorkspaceButton.dispatch("click");
    expectDockedChat(harness.dom);
    harness.dom.homeWorkspaceButton.dispatch("click");
    expect(shell.activeWorkspace()).toBe("home");
    expect(harness.documentRoot.activeElement).toBe(harness.dom.composerInput);
    expect(onWorkspaceChange.mock.calls.map(([workspace]) => workspace)).toEqual(["chat", "home"]);
  });
  test("opens Schedules as a full workspace while honoring the configuration discard guard", () => {
    let mayLeave = false;
    const guard = vi.fn(
      ({ from }: WorkspaceChange) => from !== "config" || mayLeave,
    );
    const { dom, shell, flushFrames, documentRoot } = createNavigation(
      1260,
      guard,
    );
    shell.activateWorkspace("config");
    expect(shell.activateWorkspace("schedules")).toBe(false);
    expect(dom.schedulesWorkspacePanel.hidden).toBe(true);
    mayLeave = true;
    expect(shell.activateWorkspace("schedules")).toBe(true);
    flushFrames();
    expect(dom.schedulesWorkspacePanel.hidden).toBe(false);
    expect(dom.schedulesWorkspacePanel.inert).toBe(false);
    expect(dom.configWorkspacePanel.hidden).toBe(true);
    expect(dom.chatPanel.hidden).toBe(true);
    expect(dom.sessionsPanel.hidden).toBe(true);
    expect(documentRoot.activeElement).toBe(dom.closeSchedulesWorkspaceButton);
    expect(dom.schedulesWorkspaceButton.getAttribute("aria-current")).toBe(
      "page",
    );
    expect(shell.closeOverlaysOnEscape()).toBe(true);
    expectDockedChat(dom);
  });

  test("docks conversations at the exact wide breakpoint without making Chat modal", () => {
    const { dom, shell, mediaQueries } = createNavigation(1260);

    expect(mediaQueries).toContain("(min-width: 1260px)");
    expectDockedChat(dom);
    expect(shell.setSessionsDrawerOpen(false)).toBe(true);
    expectDockedChat(dom);
    expect(shell.closeOverlaysOnEscape()).toBe(false);
    expectDockedChat(dom);
  });

  test("keeps narrow conversations closed until their toggle opens the overlay", () => {
    const { dom, documentRoot, flushFrames } = createNavigation(1259);

    expect(dom.sessionsPanel.hidden).toBe(true);
    expect(dom.chatPanel.inert).toBe(false);
    expect(dom.sessionsToggleButton.hidden).toBe(false);
    expectBackdropHidden(dom);

    dom.sessionsToggleButton.dispatch("click");
    flushFrames();

    expect(dom.sessionsPanel.hidden).toBe(false);
    expect(dom.sessionsPanel.inert).toBe(false);
    expect(dom.chatPanel.inert).toBe(true);
    expect(dom.closeSessionsButton.hidden).toBe(false);
    expect(dom.panelBackdrop.classList.contains("visible")).toBe(true);
    expect(dom.panelBackdrop.getAttribute("aria-hidden")).toBe("false");
    expect(dom.panelBackdrop.tabIndex).toBe(0);
    expect(dom.sessionsToggleButton.getAttribute("aria-expanded")).toBe("true");
    expect(documentRoot.activeElement).toBe(dom.closeSessionsButton);
  });

  test.each(["close button", "backdrop", "Escape"])(
    "%s closes a narrow overlay and restores focus to its visible toggle",
    (closeAction) => {
      const { dom, shell, documentRoot, flushFrames } = createNavigation();
      shell.setSessionsDrawerOpen(true);
      flushFrames();

      if (closeAction === "close button") {
        dom.closeSessionsButton.dispatch("click");
      }
      if (closeAction === "backdrop") dom.panelBackdrop.dispatch("click");
      if (closeAction === "Escape") {
        expect(shell.closeOverlaysOnEscape()).toBe(true);
      }
      flushFrames();

      expect(dom.sessionsPanel.hidden).toBe(true);
      expect(dom.chatPanel.inert).toBe(false);
      expect(dom.sessionsToggleButton.getAttribute("aria-expanded")).toBe(
        "false",
      );
      expectBackdropHidden(dom);
      expect(documentRoot.activeElement).toBe(dom.sessionsToggleButton);
      expect(isAvailableWorkspaceFocus(documentRoot.activeElement)).toBe(true);
    },
  );

  test.each(["close", "toggle"])(
    "repairs focus from the %s control when an open overlay becomes docked",
    (focusedControl) => {
      const { dom, shell, documentRoot, flushFrames, resize } =
        createNavigation();
      shell.setSessionsDrawerOpen(true);
      flushFrames();
      const previouslyFocused =
        focusedControl === "close"
          ? dom.closeSessionsButton
          : dom.sessionsToggleButton;
      previouslyFocused.focus();

      resize(1260);
      flushFrames();

      expectDockedChat(dom);
      expect(documentRoot.activeElement).not.toBe(previouslyFocused);
      expect(isAvailableWorkspaceFocus(documentRoot.activeElement)).toBe(true);
    },
  );

  test("does not run stale narrow focus work after the drawer has become docked", () => {
    const { dom, shell, documentRoot, flushFrames, resize } =
      createNavigation();
    dom.sessionsToggleButton.focus();
    shell.setSessionsDrawerOpen(true);

    resize(1260);
    flushFrames();

    expectDockedChat(dom);
    expect(isAvailableWorkspaceFocus(documentRoot.activeElement)).toBe(true);
    expect(documentRoot.activeElement).not.toBe(dom.closeSessionsButton);
    expect(documentRoot.activeElement).not.toBe(dom.sessionsToggleButton);
  });

  test.each([false, true])(
    "restores sidebar focus when docking ends, with browser focus eviction %s",
    (evictHiddenFocus) => {
      const { dom, documentRoot, flushFrames, resize } = createNavigation(
        1260,
        () => true,
        { evictHiddenFocus },
      );
      dom.sessionSearchInput.focus();

      resize(1259);
      flushFrames();

      expect(dom.sessionsPanel.hidden).toBe(true);
      expect(dom.sessionsPanel.inert).toBe(true);
      expect(dom.chatPanel.inert).toBe(false);
      expect(dom.sessionsToggleButton.hidden).toBe(false);
      expectBackdropHidden(dom);
      expect(documentRoot.activeElement).toBe(dom.sessionsToggleButton);
      expect(isAvailableWorkspaceFocus(documentRoot.activeElement)).toBe(true);
    },
  );

  test.each([1259, 1260])(
    "hides conversations throughout Config navigation and resizing from width %i",
    (width) => {
      const { dom, shell, resize, flushFrames } = createNavigation(width);
      shell.setSessionsDrawerOpen(true);
      flushFrames();
      dom.configWorkspaceButton.dispatch("click");
      flushFrames();
      expectConfigWithoutSessions(dom);
      expect(dom.configWorkspaceButton.getAttribute("aria-current")).toBe(
        "page",
      );

      resize(width === 1259 ? 1260 : 1259);
      flushFrames();
      expectConfigWithoutSessions(dom);

      dom.chatWorkspaceButton.dispatch("click");
      flushFrames();
      expect(dom.configWorkspacePanel.hidden).toBe(true);
      expect(dom.chatPanel.hidden).toBe(false);
      expect(dom.chatPanel.inert).toBe(false);
      expect(dom.sessionsPanel.hidden).toBe(width === 1260);
      expectBackdropHidden(dom);
    },
  );

  test("retains narrow behavior for legacy viewport shims without matchMedia", () => {
    const { dom, shell } = createNavigation(1800, () => true, {
      matchMedia: false,
    });
    expect(dom.sessionsPanel.hidden).toBe(true);
    expect(shell.setSessionsDrawerOpen(true, { focus: false })).toBe(true);
    expect(dom.sessionsPanel.hidden).toBe(false);
    expect(dom.chatPanel.inert).toBe(true);
  });
});

describe("Configuration owns Operations without bypassing draft protection", () => {
  test("switches all internal operation tabs and keyboard focus without leaving Config", () => {
    const guard = vi.fn<WorkspaceGuard>(() => true);
    const { dom, shell, documentRoot } = createNavigation(1260, guard);
    shell.activateWorkspace("config", { focus: false });
    guard.mockClear();

    for (const button of dom.operationsTabButtons) {
      button.dispatch("click");
      expectConfigWithoutSessions(dom);
      expect(button.getAttribute("aria-selected")).toBe("true");
      expect(button.tabIndex).toBe(0);
      expect(
        dom.operationsTabPages
          .filter((page) => !page.hidden)
          .map((page) => page.id),
      ).toEqual([`${button.dataset.tab}Tab`]);
    }

    const preventDefault = vi.fn();
    dom.operationsTabButtons[2].dispatch("keydown", {
      key: "ArrowRight",
      preventDefault,
    });
    expect(documentRoot.activeElement).toBe(dom.operationsTabButtons[0]);
    expect(dom.operationsTabPages[0].hidden).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(guard).not.toHaveBeenCalled();
  });

  test.each([1259, 1260])(
    "preserves Config when Chat, sessions, close, or Escape is vetoed at width %i",
    (width) => {
      const guard = vi.fn<WorkspaceGuard>(({ from }) => from !== "config");
      const { dom, shell, documentRoot, flushFrames } = createNavigation(
        width,
        guard,
      );
      dom.configWorkspaceButton.dispatch("click");
      flushFrames();
      const configFocus = documentRoot.activeElement;
      guard.mockClear();

      expect(shell.activateWorkspace("chat")).toBe(false);
      expect(shell.setSessionsDrawerOpen(true)).toBe(false);
      expect(shell.closeOverlaysOnEscape()).toBe(false);
      dom.closeConfigWorkspaceButton.dispatch("click");
      dom.chatWorkspaceButton.dispatch("click");
      expect(shell.prepareWorkspaceActivation("chat")).toBeNull();
      flushFrames();

      expectConfigWithoutSessions(dom);
      expect(documentRoot.activeElement).toBe(configFocus);
      expect(guard).toHaveBeenCalledTimes(6);
      for (const [transition] of guard.mock.calls) {
        expect(transition).toEqual({ from: "config", to: "chat" });
      }
    },
  );

  test("defers draft discard until prepared Chat activation and commits it only once", () => {
    const discardDraft = vi.fn();
    const { dom, shell } = createNavigation(1260, ({ from }) => {
      if (from === "config") return discardDraft;
      return true;
    });
    shell.activateWorkspace("config", { focus: false });

    const activateChat = shell.prepareWorkspaceActivation("chat", {
      focus: false,
    });
    expect(activateChat).toBeTypeOf("function");
    expect(discardDraft).not.toHaveBeenCalled();
    expectConfigWithoutSessions(dom);

    expect(activateChat?.()).toBe(true);
    expect(activateChat?.()).toBe(true);
    expect(discardDraft).toHaveBeenCalledOnce();
    expectDockedChat(dom);
  });
});
