import { describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
// @ts-expect-error Browser-only JavaScript module has no declaration surface.
import { configurationCategoryForWorkspace, isConfigurationWorkspace } from "../../web-ui/app/lib/configuration-pages.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

const pages = [
  { workspace: "models", title: "Models", category: "models", button: "modelsWorkspaceButton" },
  { workspace: "plugins", title: "Plugins", category: "plugins", button: "pluginsWorkspaceButton" },
  { workspace: "config", title: "System", category: "operations", button: "configWorkspaceButton" },
] as const;
type Page = (typeof pages)[number];

function createNavigation(width = 1440) {
  const harness = createWorkspaceShellHarness(width);
  const prepareDiscard = vi.fn<() => boolean | (() => void)>(() => true);
  const setCategory = vi.fn();
  const shell = createWorkspaceShell({
    ...harness,
    beforeWorkspaceChange: ({ from, to }: { from: string; to: string }) => {
      if (!isConfigurationWorkspace(from) || from === to) return true;
      return prepareDiscard();
    },
    onWorkspaceChange: (workspace: string) => {
      const category = configurationCategoryForWorkspace(workspace);
      if (category) setCategory(category);
    },
  });
  shell.bind();
  shell.load();
  return { ...harness, shell, prepareDiscard, setCategory };
}

describe("standalone configuration sidebar pages", () => {
  test.each([1259, 1440])("reuses the editing panel with one current page at width %i", (width) => {
    const f = createNavigation(width);
    const panel = f.dom.configWorkspacePanel;
    for (const page of pages) {
      f.dom[page.button].dispatch("click");
      f.flushFrames();
      expect(f.shell.activeWorkspace()).toBe(page.workspace);
      expect(f.dom.configWorkspacePanel).toBe(panel);
      expect(panel.hidden).toBe(false);
      expect(panel.inert).toBe(false);
      expect(panel.getAttribute("aria-hidden")).toBe("false");
      expect(f.dom.configWorkspaceTitle.textContent).toBe(page.title);
      expect(f.dom.configWorkspaceDescription.textContent).not.toBe("");
      expect(f.setCategory).toHaveBeenLastCalledWith(page.category);
      expect(f.documentRoot.activeElement).toBe(f.dom.closeConfigWorkspaceButton);
      expect(f.dom.homeWorkspacePanel.hidden).toBe(true);
      expect(f.dom.chatPanel.hidden).toBe(true);
      expect(f.dom.sessionsPanel.hidden).toBe(true);
      for (const candidate of pages) {
        const current = candidate === page ? "page" : null;
        expect(f.dom[candidate.button].getAttribute("aria-current")).toBe(current);
      }
    }
    f.dom.homeWorkspaceButton.dispatch("click");
    expect(panel.hidden).toBe(true);
    for (const page of pages) expect(f.dom[page.button].getAttribute("aria-current")).toBeNull();
  });

  const transitions = pages.flatMap((from) =>
    pages.filter((to) => to !== from).map((to) => ({ from, to })),
  );
  test.each(transitions)("guards unsaved changes from $from.title to $to.title", ({ from, to }) => {
    const f = createNavigation();
    f.dom[from.button].dispatch("click");
    f.flushFrames();
    f.prepareDiscard.mockReturnValue(false);
    const originalCategoryCalls = f.setCategory.mock.calls.length;
    f.dom[to.button].dispatch("click");
    f.flushFrames();
    expect(f.prepareDiscard).toHaveBeenCalledOnce();
    expect(f.shell.activeWorkspace()).toBe(from.workspace);
    expect(f.dom.configWorkspaceTitle.textContent).toBe(from.title);
    expect(f.dom[from.button].getAttribute("aria-current")).toBe("page");
    expect(f.dom[to.button].getAttribute("aria-current")).toBeNull();
    expect(f.setCategory).toHaveBeenCalledTimes(originalCategoryCalls);
    const discard = vi.fn();
    f.prepareDiscard.mockReturnValue(discard);
    f.dom[to.button].dispatch("click");
    expect(discard).toHaveBeenCalledOnce();
    expect(f.shell.activeWorkspace()).toBe(to.workspace);
    expect(f.setCategory).toHaveBeenLastCalledWith(to.category);
  });

  test.each(pages)("protects $title drafts on Escape and Back to chat", (page: Page) => {
    const f = createNavigation();
    f.dom[page.button].dispatch("click");
    f.prepareDiscard.mockReturnValue(false);
    expect(f.shell.closeOverlaysOnEscape()).toBe(false);
    f.dom.closeConfigWorkspaceButton.dispatch("click");
    expect(f.shell.activeWorkspace()).toBe(page.workspace);
    expect(f.prepareDiscard).toHaveBeenCalledTimes(2);
    f.dom[page.button].dispatch("click");
    expect(f.prepareDiscard).toHaveBeenCalledTimes(2);
    f.prepareDiscard.mockReturnValue(true);
    expect(f.shell.closeOverlaysOnEscape()).toBe(true);
    expect(f.shell.activeWorkspace()).toBe("chat");
  });

  test("defers draft discard until prepared sidebar navigation commits", () => {
    const f = createNavigation();
    f.dom.modelsWorkspaceButton.dispatch("click");
    const discard = vi.fn();
    f.prepareDiscard.mockReturnValue(discard);
    const activate = f.shell.prepareWorkspaceActivation("plugins", { focus: false });
    expect(discard).not.toHaveBeenCalled();
    expect(f.shell.activeWorkspace()).toBe("models");
    expect(activate()).toBe(true);
    expect(activate()).toBe(true);
    expect(discard).toHaveBeenCalledOnce();
    expect(f.shell.activeWorkspace()).toBe("plugins");
  });
});
