import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error Browser-only module has no declaration surface.
import { createProjectsFeature } from "../../web-ui/app/projects-feature.js";
import { projectClient } from "./support/projects-controller-fixture.js";
import { SidebarElement } from "./support/session-sidebar-dom.js";
import type { ContextElement } from "./support/composer-context-window-dom.js";

vi.mock("../../web-ui/app/components/project-creation.js", () => ({
  createProjectCreation: () => ({ render: vi.fn() }),
}));
afterEach(() => vi.unstubAllGlobals());

function sessionsFor(projectId: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `${projectId}-${index}`, projectId }));
}

function fixture(sessions = [...sessionsFor("first", 7), ...sessionsFor("second", 8)]) {
  let environment = "prod";
  const state = { sessions, currentSessionId: "", sessionQuery: "" };
  const dom = { currentProjectContext: new SidebarElement("div"), projectCreationRoot: new SidebarElement("div") };
  vi.stubGlobal("document", { createElement: (tag: string) => new SidebarElement(tag) });
  const feature = createProjectsFeature({
    dom, state, client: projectClient(), shell: { showToast: vi.fn() },
    selectedEnvironmentId: () => environment,
    conversationSession: { loadSessions: vi.fn(), openSession: vi.fn() },
    renderSessions: vi.fn(), prepareConversation: vi.fn(),
  });
  function render() {
    const root = new SidebarElement("div");
    feature.renderSessionGroups({
      root, sessions: state.sessions,
      createSessionItem: (session: { id: string }) => {
        const row = new SidebarElement("article");
        row.dataset.sessionId = session.id;
        return row;
      },
    });
    return root;
  }
  return { state, render, setEnvironment: (id: string) => { environment = id; } };
}

function content(root: ContextElement, projectId = "first") {
  return root.querySelector(`#project-sessions-${projectId}`)!;
}

function visibleIds(root: ContextElement, projectId = "first") {
  return content(root, projectId).querySelector(".project-session-rows")!.children
    .filter((row) => !row.hidden).map((row) => row.dataset.sessionId);
}

describe("project conversation preview", () => {
  test("shows the first five in existing order, expands and collapses without replacing the button", () => {
    const f = fixture();
    const root = f.render();
    expect(visibleIds(root)).toEqual(["first-0", "first-1", "first-2", "first-3", "first-4"]);
    const toggle = content(root).querySelector(".project-session-more")!;
    expect(toggle.textContent).toBe("Show more (2)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(content(root).querySelector(".project-session-rows")!.id);
    toggle.dispatch("click");
    expect(visibleIds(root)).toHaveLength(7);
    expect(visibleIds(root, "second")).toHaveLength(5);
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(content(root).querySelector(".project-session-more")).toBe(toggle);
    toggle.dispatch("click");
    expect(visibleIds(root)).toHaveLength(5);
  });

  test("retains expansion across sidebar rerenders and lets search reveal all matches without changing it", () => {
    const f = fixture();
    content(f.render()).querySelector(".project-session-more")!.dispatch("click");
    expect(visibleIds(f.render())).toHaveLength(7);
    f.state.sessionQuery = "match";
    const search = f.render();
    expect(visibleIds(search)).toHaveLength(7);
    expect(visibleIds(search, "second")).toHaveLength(8);
    expect(content(search).querySelector(".project-session-more")).toBeNull();
    f.state.sessionQuery = "  ";
    const restored = f.render();
    expect(visibleIds(restored)).toHaveLength(7);
    expect(visibleIds(restored, "second")).toHaveLength(5);
  });

  test("clears expansion when changing environments and returning to the previous environment", () => {
    const f = fixture();
    content(f.render()).querySelector(".project-session-more")!.dispatch("click");
    f.setEnvironment("dev");
    expect(visibleIds(f.render())).toHaveLength(5);
    f.setEnvironment("prod");
    expect(visibleIds(f.render())).toHaveLength(5);
  });

  test("keeps manually ordered older conversations in the preview and avoids controls for five or fewer", () => {
    const sessions = sessionsFor("first", 7);
    const f = fixture([sessions[6]!, ...sessions.slice(0, 6)]);
    expect(visibleIds(f.render())).toEqual(["first-6", "first-0", "first-1", "first-2", "first-3"]);
    f.state.sessions = sessions.slice(0, 5);
    expect(content(f.render()).querySelector(".project-session-more")).toBeNull();
    f.state.sessions = sessions.slice(0, 1);
    expect(visibleIds(f.render())).toEqual(["first-0"]);
  });
});
