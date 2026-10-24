import { afterEach, expect, test, vi } from "vitest";
// @ts-expect-error Browser module.
import { createPreferenceViewSync } from "../../web-ui/app/controllers/preference-view-sync.js";
// @ts-expect-error Browser module.
import { createWorkspaceStateStorage } from "../../web-ui/app/services/workspace-state-storage.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
// @ts-expect-error Browser module.
import { createAppState } from "../../web-ui/app/app-state.js";
// @ts-expect-error Browser module.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";
import { createConversationSessionController } from "../../web-ui/app/controllers/conversation-session-controller.js";
// @ts-expect-error Browser module.
import { createWorkspaceShell } from "../../web-ui/app/components/workspace-shell.js";
// @ts-expect-error Browser module.
import { createDashboardController } from "../../web-ui/app/controllers/dashboard-controller.js";
import { allSidebarElements, SidebarElement } from "./support/session-sidebar-dom.js";
import { createWorkspaceShellHarness } from "./support/workspace-shell-harness.js";

class SessionList extends SidebarElement {
  private offset = 0;
  constructor(private readonly isVisible: () => boolean) { super("div"); }
  get ownerDocument() { return { createElement: (tag: string) => new SidebarElement(tag) }; }
  getClientRects() { return this.isVisible() ? [{}] : []; }
  get scrollTop() { return this.isVisible() ? this.offset : 0; }
  set scrollTop(value: number) { if (this.isVisible()) this.offset = value; }
  override replaceChildren(...children: SidebarElement[]) {
    this.offset = 0;
    super.replaceChildren(...children);
  }
}

async function fixture(width: number) {
  let serverState = { version: 1, revision: 0, preferences: {} as Record<string, string>, queue: "[]" };
  const storage = createWorkspaceStateStorage({
    fetchImpl: vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) {
        const input = JSON.parse(String(init.body));
        serverState = { ...serverState, revision: serverState.revision + 1, preferences: { ...serverState.preferences, [input.key]: input.value } };
      }
      return Response.json({ state: serverState });
    }),
  });
  await storage.refresh();
  const preferences = createClientPreferences(storage);
  const h = createWorkspaceShellHarness(width);
  const root = new SessionList(() => !h.dom.sessionsPanel.hidden);
  vi.stubGlobal("document", { createElement: (tag: string) => new SidebarElement(tag) });
  const state = createAppState();
  let environmentId = "dev";
  const selectedEnvironmentId = () => environmentId;
  const dom = { ...h.dom, sessionsList: root, sessionsCount: new SidebarElement("span"), sessionTitle: new SidebarElement("span") };
  const shell = createWorkspaceShell({ ...h, dom });
  const client = {
    listSessions: vi.fn(async (_environment: string, input: { cursor?: string }) => {
      const offset = Number(input.cursor ?? 0);
      return {
        sessions: Array.from({ length: 20 }, (_, i) => ({ id: "session-" + (offset + i), title: "Session " + (offset + i) })),
        nextCursor: offset < 40 ? String(offset + 20) : null, total: 60,
      };
    }),
    loadSession: vi.fn(async () => ({ title: "Loaded older conversation", messages: [{ id: 1, role: "assistant", text: "Stored answer" }], requests: [], readState: { unreadCount: 0 } })),
    markSessionRead: vi.fn(async () => ({ readState: { unreadCount: 0, lastReadAt: 100 } })),
    fetchRequestEvents: vi.fn(async () => []),
  };
  let conversation: ReturnType<typeof createConversationSessionController>;
  const sessions = createSessionController({
    state, dom, preferences, selectedEnvironmentId, shell, client,
    sessionActionsMenu: { reset: vi.fn() }, confirmAction: () => false, copyText: vi.fn(),
    onOpen: (sessionId: string) => conversation.openSession(sessionId),
  });
  let pagination!: { load(more?: boolean): Promise<unknown> };
  const setPagination = sessions.setPagination;
  sessions.setPagination = (value: typeof pagination) => { pagination = value; setPagination(value); };
  const scheduled: Array<() => void> = [];
  conversation = createConversationSessionController({
    state, dom, client, preferences, sessions, selectedEnvironmentId,
    sessionQueue: { peek: () => null, rebindBlocked: vi.fn() },
    conversationView: { reset: vi.fn() },
    applyConversationChrome: vi.fn(), applyModelSelection: vi.fn(),
    renderSessions: sessions.render, renderMessages: vi.fn(), updateComposerSendState: vi.fn(),
    setMessageStatus: vi.fn(), sendRealtime: () => true, handleRealtimeMessage: vi.fn(),
    recordEvent: vi.fn(), recordControlEvent: vi.fn(), reportQueueFailure: vi.fn(),
    drainQueuedMessage: vi.fn(), suspendQueueRecovery: () => true, recoverBlockedQueue: vi.fn(),
    isCurrentComposerScope: () => true, scheduleTask: (callback: () => void) => { scheduled.push(callback); },
  });
  const loadSessions = vi.fn(conversation.loadSessions);
  const dashboard = createDashboardController({
    client, getEnvironmentId: selectedEnvironmentId, getSessions: () => state.sessions,
    loadSessions, render: vi.fn(), isVisible: () => true,
  });
  const selection = {
    loadPreferences: () => { state.pinnedSessionIds = preferences.loadPinnedSessions(); },
    applyModelSelection: vi.fn(), renderPermissionMode: vi.fn(),
  };
  const sync = createPreferenceViewSync({ preferences, selection, dashboard, getEnvironmentId: selectedEnvironmentId, loadSessions });
  preferences.subscribe(sync.synchronize);
  shell.load();
  shell.setSessionsDrawerOpen(true, { focus: false });
  dashboard.setActive(false);
  dashboard.setReady();
  sync.setReady();
  await vi.waitFor(() => expect(state.sessions).toHaveLength(20));
  return { state, root, client, preferences, storage, shell, conversation, sessions, pagination, loadSessions, dashboard, selection,
    select: (id: string) => allSidebarElements(root).find((item) => item.id === "session-open-" + id)!.dispatch("click"),
    flushRead: async () => { for (const run of scheduled.splice(0)) run(); await vi.waitFor(() => expect(client.markSessionRead).toHaveBeenCalled()); },
    refreshClientState: async () => { serverState = { ...serverState, revision: serverState.revision + 1 }; await storage.refresh(); },
    changeEnvironment: () => { environmentId = "prod"; conversation.invalidateEnvironmentLoads(); sync.synchronize(); },
  };
}

afterEach(() => vi.unstubAllGlobals());

test.each([1100, 1440])("selection ACK and read events preserve loaded pages and scroll at width %s", async (width) => {
  const f = await fixture(width);
  await f.pagination.load(true);
  expect(f.state.sessions).toHaveLength(40);
  f.root.scrollTop = 730;
  const listReads = f.client.listSessions.mock.calls.length;
  f.select("session-35");
  await vi.waitFor(() => expect(f.client.loadSession).toHaveBeenCalledOnce());
  await f.storage.flush();
  await f.flushRead();
  await f.refreshClientState();
  f.dashboard.handleRealtime({ type: "workspace_changed", environment: "dev", resources: ["sessions"] });
  f.sessions.applyReadState("session-35", { unreadCount: 0, lastReadAt: 101 });
  expect(f.preferences.sessionIdForEnvironment("dev")).toBe("session-35");
  expect(f.client.listSessions).toHaveBeenCalledTimes(listReads);
  expect(f.state.sessions).toHaveLength(40);
  expect(allSidebarElements(f.root).filter((item) => item.classList.contains("session-open-button"))).toHaveLength(40);
  expect(f.root.querySelector(".session-archive-toggle")?.textContent).toBe("Load more conversations");
  expect(f.state.sessions.find((row: { id: string }) => row.id === "session-35").title).toBe("Loaded older conversation");
  f.shell.setSessionsDrawerOpen(true, { focus: false });
  expect(f.root.scrollTop).toBe(730);
  await f.pagination.load(true);
  expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", expect.objectContaining({ cursor: "40" }));
  expect(f.state.sessions).toHaveLength(60);
});

test("unrelated model and permission preference acknowledgements do not reload the list", async () => {
  const f = await fixture(1440);
  await f.pagination.load(true);
  const calls = f.client.listSessions.mock.calls.length;
  await f.preferences.saveModelPreferences({ "session-2": "luna" }, { dev: "luna" });
  await f.preferences.saveLastToolPermissionMode("full_access");
  expect(f.client.listSessions).toHaveBeenCalledTimes(calls);
  expect(f.state.sessions).toHaveLength(40);
  expect(f.selection.applyModelSelection).toHaveBeenCalled();
  expect(f.selection.renderPermissionMode).toHaveBeenCalled();
});

test("pins, archive/order preferences and environment changes still reload their canonical list", async () => {
  const f = await fixture(1440);
  await f.preferences.savePinnedSessions(["session-35"]);
  await vi.waitFor(() => expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", expect.objectContaining({ pinnedSessionIds: ["session-35"], cursor: null })));
  await f.preferences.saveSessionSidebar("dev", { archivedSessionIds: ["session-3"], orderedSessionIds: ["session-2", "session-1"] });
  await vi.waitFor(() => expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", expect.objectContaining({
    archivedSessionIds: ["session-3"], orderedSessionIds: ["session-2", "session-1"], cursor: null,
  })));
  f.changeEnvironment();
  await vi.waitFor(() => expect(f.client.listSessions).toHaveBeenLastCalledWith("prod", expect.objectContaining({
    archivedSessionIds: [], orderedSessionIds: [], cursor: null,
  })));
});
