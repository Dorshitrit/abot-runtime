import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser module.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";
// @ts-expect-error Browser module.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
import { allSidebarElements, SidebarElement } from "./support/session-sidebar-dom.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

class ScrollableSessionList extends SidebarElement {
  private offset = 0;
  constructor(private readonly isVisible: () => boolean) { super("div"); }
  getClientRects() { return this.isVisible() ? [{}] : []; }
  get scrollTop() { return this.isVisible() ? this.offset : 0; }
  set scrollTop(value: number) { if (this.isVisible()) this.offset = value; }
  override replaceChildren(...children: SidebarElement[]) {
    this.offset = 0;
    super.replaceChildren(...children);
  }
}

async function fixture(width = 1100) {
  const h = createWorkspaceShellHarness(width);
  const root = new ScrollableSessionList(() => !h.dom.sessionsPanel.hidden);
  let environment = "dev";
  let archivedSessionIds: string[] = [];
  const state = {
    sessions: Array.from({ length: 40 }, (_, index) => ({ id: "session-" + index })),
    pinnedSessionIds: [], busySessionIds: new Set(), currentSessionId: "session-1", sessionQuery: "",
  };
  vi.stubGlobal("document", { createElement: (tag: string) => new SidebarElement(tag) });
  const dom = { ...h.dom, sessionsList: root, sessionsCount: new SidebarElement("span"), sessionTitle: new SidebarElement("span") };
  const shell = createWorkspaceShell({ ...h, dom });
  const controller = createSessionController({
    state, dom, shell, selectedEnvironmentId: () => environment,
    preferences: { loadSessionSidebar: () => ({ archivedSessionIds, orderedSessionIds: [] }) },
    sessionActionsMenu: { reset: vi.fn() }, confirmAction: () => false, copyText: vi.fn(),
    onOpen: (sessionId: string) => { state.currentSessionId = sessionId; controller.render(); },
  });
  shell.load();
  await shell.setSessionsDrawerOpen(true, { focus: false });
  controller.render();
  return { ...h, dom, root, state, shell, controller,
    changeEnvironment: () => { environment = "prod"; controller.render(); },
    addArchivedSession: () => { archivedSessionIds = ["session-0"]; controller.render(); },
    select: (id: string) => allSidebarElements(root).find((item) => item.id === "session-open-" + id)!.dispatch("click"),
  };
}

afterEach(() => vi.unstubAllGlobals());

test.each([1100, 1440])("switching conversation keeps the list position at viewport width %s", async (width) => {
  const f = await fixture(width);
  const sessions = f.state.sessions;
  f.root.scrollTop = 730;
  f.select("session-30");
  expect(f.state.currentSessionId).toBe("session-30");
  expect(f.state.sessions).toBe(sessions);
  f.controller.applyTitle("session-30", "Loaded title");
  f.controller.applyReadState("session-30", { unreadCount: 0 });
  await f.shell.setSessionsDrawerOpen(true, { focus: false });
  expect(f.root.scrollTop).toBe(730);
});

test("the saved position survives repeated hidden renders and resets after a hidden search change", async () => {
  const f = await fixture();
  f.root.scrollTop = 620;
  await f.shell.setSessionsDrawerOpen(false);
  f.controller.render();
  f.controller.render();
  await f.shell.setSessionsDrawerOpen(true, { focus: false });
  expect(f.root.scrollTop).toBe(620);
  await f.shell.setSessionsDrawerOpen(false);
  f.state.sessionQuery = "session-3";
  f.controller.render();
  await f.shell.setSessionsDrawerOpen(true, { focus: false });
  expect(f.root.scrollTop).toBe(0);
});

test("environment and archive changes start at the beginning of the new list", async () => {
  const f = await fixture(1440);
  f.root.scrollTop = 800;
  f.changeEnvironment();
  expect(f.root.scrollTop).toBe(0);
  f.addArchivedSession();
  f.root.scrollTop = 400;
  f.root.querySelector(".session-archive-toggle")!.dispatch("click");
  expect(f.root.scrollTop).toBe(0);
});

test("a hidden sidebar keeps its position when leaving and returning to Chat", async () => {
  const f = await fixture(1440);
  f.root.scrollTop = 900;
  await f.shell.activateWorkspace("home", { focus: false });
  f.controller.render();
  await f.shell.activateWorkspace("chat", { focus: false });
  expect(f.root.scrollTop).toBe(900);
});
