import { afterEach, expect, test, vi } from "vitest";
import { sidebarMetadataPage } from "../../web-ui/session-read-state/sidebar-pagination.js";
import { projectSessionMetadata } from "../../sessions/metadata/projection.js";
import type { SessionListItem } from "../../sessions/types.js";
// @ts-expect-error Browser controller has no declaration surface.
import { createSessionListPagination } from "../../web-ui/app/controllers/session-list-pagination.js";
// @ts-expect-error Browser controller has no declaration surface.
import { createSessionController } from "../../web-ui/app/controllers/session-controller.js";
// @ts-expect-error Browser component has no declaration surface.
import { renderProjectSessionGroups } from "../../web-ui/app/components/project-session-groups.js";
import { createClientPreferences } from "../../web-ui/app/services/client-preferences.js";
import { allSidebarElements, SidebarElement, sidebarStorage } from "./support/session-sidebar-dom.js";
import type { ContextElement } from "./support/composer-context-window-dom.js";

type Query = Parameters<typeof sidebarMetadataPage>[1];
const projects = ["first", "second", "old", "empty", "removed"].map((id) => ({
  id, name: id, directory: "/work/" + id, createdAt: new Date(0).toISOString(),
}));
const catalog = { projects: projects.filter((project) => project.id !== "removed"), deletedProjectIds: ["removed"] };
function recordsFor(prefix: string, count: number, start: number, projectId?: string) {
  return Array.from({ length: count }, (_, index) => projectSessionMetadata({
    id: prefix + "-" + index, title: prefix + "-" + index,
    project: projects.find((project) => project.id === projectId),
    createdAt: new Date(start + index).toISOString(), updatedAt: new Date(start + index).toISOString(),
    lastAgentMode: "reasoning", messageCount: 0, messages: [],
  }, "fixture"));
}
const records = [
  ...recordsFor("first", 50, 10_000, "first"), ...recordsFor("second", 8, 5_000, "second"),
  ...recordsFor("old", 1, 1, "old"), ...recordsFor("ordinary", 30, 100),
  ...recordsFor("removed", 1, 2, "removed"),
];
function response(input: Query, currentCatalog = catalog) {
  const { records: selected, ...page } = sidebarMetadataPage(records, input, 20, currentCatalog);
  return { sessions: selected.map((record) => record.summary), ...page };
}
type Response = ReturnType<typeof response>;
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
class SessionList extends SidebarElement {
  scrollTop = 0;
  get ownerDocument() { return { createElement: (tag: string) => new SidebarElement(tag) }; }
  getClientRects() { return [{}]; }
}
function isVisibleSidebarElement(element: ContextElement): boolean {
  if (element.hidden) return false;
  if (!element.parentElement) return true;
  return isVisibleSidebarElement(element.parentElement);
}
async function fixture() {
  let environment = "dev";
  let currentCatalog = catalog;
  const root = new SessionList("div");
  const expanded = new Set<string>();
  const preferences = createClientPreferences(sidebarStorage());
  await preferences.saveSessionSidebar("dev", {
    archivedSessionIds: ["first-0", "ordinary-0"], orderedSessionIds: [],
  });
  const state = {
    sessions: [] as SessionListItem[], pinnedSessionIds: ["first-49", "ordinary-29"],
    currentSessionId: "", sessionQuery: "", sessionModels: {}, busySessionIds: new Set<string>(),
  };
  const client = {
    supportsProjects: () => true,
    listSessions: vi.fn(async (_environment: string, input: Query) => response(input, currentCatalog)),
  };
  const documentRoot = {
    createElement: (tag: string) => new SidebarElement(tag),
    getElementById: (id: string) => allSidebarElements(root).find((element) => element.id === id),
  };
  vi.stubGlobal("document", documentRoot);
  const controller = createSessionController({
    state, preferences, client, selectedEnvironmentId: () => environment,
    getDeletedProjectIds: () => [],
    dom: { sessionsList: root, sessionsCount: new SidebarElement("span") },
    sessionActionsMenu: { reset: vi.fn() }, shell: { showToast: vi.fn() },
    renderGroups: (input: object) => {
      renderProjectSessionGroups({
        ...input, projects: [], deletedProjectIds: [], query: state.sessionQuery,
        documentRoot, onNewConversation: vi.fn(), onRetry: vi.fn(),
        expandedProjectSessionIds: expanded,
        onToggleProjectSessions: (id: string, visible: boolean) => {
          if (visible) expanded.add(id);
          else expanded.delete(id);
        },
      });
      return true;
    },
  });
  const pagination = createSessionListPagination({
    state, dom: { sessionsList: root }, client, sessions: controller,
    selectedEnvironmentId: () => environment, renderSessions: controller.render,
    onSessionListState: vi.fn(),
  });
  await pagination.load();
  const group = (id: string) => root.querySelector("#project-sessions-" + id);
  const visibleIds = (parent: ContextElement = root) => allSidebarElements(parent)
    .filter(isVisibleSidebarElement).filter((item) => item.classList.contains("session-open-button"))
    .map((item) => item.id.replace("session-open-", ""));
  const ordinaryIds = () => root.children.filter((item) => item.classList.contains("session-item"))
    .map((item) => item.querySelector(".session-open-button")!.id.replace("session-open-", ""))
    .filter((id) => !state.pinnedSessionIds.includes(id));
  const pageFor = (id: string) => pagination.info().projectPages.find((page: { projectId: string }) => page.projectId === id);
  return { root, state, client, preferences, pagination, controller, group, visibleIds, ordinaryIds, pageFor,
    changeEnvironment: () => { environment = "prod"; pagination.invalidate(); },
    respond: (input: Query) => response(input, currentCatalog),
    deleteProject: (id: string) => {
      currentCatalog = { projects: currentCatalog.projects.filter((project) => project.id !== id),
        deletedProjectIds: [...currentCatalog.deletedProjectIds, id] };
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

test("the first response gives ordinary conversations their own page and displays every project", async () => {
  const f = await fixture();
  expect(f.client.listSessions).toHaveBeenCalledExactlyOnceWith("dev", expect.objectContaining({ sidebar: true, cursor: null }));
  expect(catalog.projects.map((project) => Boolean(f.group(project.id)))).toEqual([true, true, true, true]);
  expect(f.group("removed")).toBeNull();
  expect(f.visibleIds(f.group("first")!)).toHaveLength(5);
  expect(f.visibleIds(f.group("second")!)).toHaveLength(5);
  expect(f.visibleIds(f.group("old")!)).toEqual(["old-0"]);
  expect(f.visibleIds(f.group("empty")!)).toEqual([]);
  expect(f.ordinaryIds()).toHaveLength(20);
  expect(f.pagination.info().ordinaryTotal).toBe(29);
  expect(f.pageFor("first").total).toBe(48);
  expect(f.pageFor("second").total).toBe(8);
  expect(f.pagination.info().archivedCount).toBe(2);
  expect(f.visibleIds().slice(0, 2)).toEqual(["first-49", "ordinary-29"]);
  expect(f.visibleIds()).not.toContain("first-0");
  expect(f.visibleIds()).not.toContain("ordinary-0");
  expect(new Set(f.visibleIds()).size).toBe(f.visibleIds().length);
  expect(f.root.querySelector(".ordinary-conversations-heading")!.textContent).toBe("Conversations (29)");
});

test("project expansion and ordinary continuation use independent cursors and preserve other groups", async () => {
  const f = await fixture();
  const firstCursor = f.pageFor("first").nextCursor;
  const secondPage = { ...f.pageFor("second") };
  f.group("first")!.querySelector(".project-session-more")!.dispatch("click");
  await vi.waitFor(() => expect(f.visibleIds(f.group("first")!)).toHaveLength(25));
  expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", expect.objectContaining({
    sidebar: true, scope: { kind: "project", projectId: "first" }, cursor: firstCursor,
  }));
  expect(f.ordinaryIds()).toHaveLength(20);
  expect(f.visibleIds(f.group("second")!)).toHaveLength(5);
  expect(f.pageFor("second")).toEqual(secondPage);
  const continuedFirst = { ...f.pageFor("first") };
  await f.pagination.load(true);
  expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", expect.objectContaining({ scope: { kind: "ordinary" } }));
  expect(f.ordinaryIds()).toHaveLength(29);
  expect(f.ordinaryIds()).toContain("removed-0");
  expect(f.pageFor("first")).toEqual(continuedFirst);
  expect(f.pageFor("second")).toEqual(secondPage);
  expect(f.visibleIds(f.group("first")!)).toHaveLength(25);
  f.group("first")!.querySelector(".project-session-load-more")!.dispatch("click");
  await vi.waitFor(() => expect(f.visibleIds(f.group("first")!)).toHaveLength(45));
  expect(f.ordinaryIds()).toHaveLength(29);
  f.group("first")!.querySelector(".project-session-more")!.dispatch("click");
  expect(f.visibleIds(f.group("first")!)).toHaveLength(5);
  expect(f.visibleIds(f.group("second")!)).toHaveLength(5);
  expect(new Set(f.state.sessions.map((session) => session.id)).size).toBe(f.state.sessions.length);
});

test("a pending or failed project page does not block ordinary paging, and retry retains its cursor", async () => {
  const f = await fixture();
  const pending = deferred();
  const cursor = f.pageFor("first").nextCursor;
  f.client.listSessions.mockImplementationOnce(() => pending.promise);
  f.group("first")!.querySelector(".project-session-more")!.dispatch("click");
  expect(f.pageFor("first").pending).toBe(true);
  expect(f.visibleIds(f.group("first")!)).toHaveLength(5);
  await f.pagination.load(true);
  expect(f.ordinaryIds()).toHaveLength(29);
  pending.reject(new Error("project unavailable"));
  await vi.waitFor(() => expect(f.pageFor("first").errorMessage).toBeTruthy());
  expect(f.pageFor("first").pending).toBe(false);
  expect(f.visibleIds(f.group("first")!)).toHaveLength(5);
  const retry = f.group("first")!.querySelector(".project-session-load-more")!;
  expect(retry.disabled).toBe(false);
  retry.dispatch("click");
  await vi.waitFor(() => expect(f.visibleIds(f.group("first")!)).toHaveLength(25));
  expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", expect.objectContaining({
    scope: { kind: "project", projectId: "first" }, cursor,
  }));
  expect(f.pageFor("first").errorMessage).toBeFalsy();
  expect(f.ordinaryIds()).toHaveLength(29);
});

test.each(["search", "environment"])("a project response from an earlier %s cannot append or replace current pages", async (change) => {
  const f = await fixture();
  const pending = deferred();
  f.client.listSessions.mockImplementationOnce(() => pending.promise);
  const loading = f.pagination.loadProject("first");
  const lateResponse = response(f.client.listSessions.mock.calls.at(-1)![1]);
  if (change === "search") f.state.sessionQuery = "ordinary-2";
  if (change === "environment") f.changeEnvironment();
  await f.pagination.load();
  const currentIds = f.state.sessions.map((session) => session.id);
  const currentInfo = JSON.stringify(f.pagination.info());
  pending.resolve(lateResponse);
  await loading;
  expect(f.state.sessions.map((session) => session.id)).toEqual(currentIds);
  expect(JSON.stringify(f.pagination.info())).toBe(currentInfo);
});


test("archived pins use their project group once while archived ordinary conversations keep their own count", async () => {
  const f = await fixture();
  await f.controller.archiveSession("first-49");
  await vi.waitFor(() => expect(f.pagination.info().archivedCount).toBe(3));
  expect(f.visibleIds()).not.toContain("first-49");
  f.root.querySelector(".session-archive-toggle")!.dispatch("click");
  await vi.waitFor(() => expect(f.pagination.info().ordinaryTotal).toBe(1));
  expect(f.root.querySelector(".pinned-conversations-heading")).toBeNull();
  expect(f.visibleIds(f.group("first")!)).toEqual(["first-49", "first-0"]);
  expect(f.visibleIds()).toEqual(["first-49", "first-0", "ordinary-0"]);
  expect(f.pageFor("first").total).toBe(2);
  expect(f.ordinaryIds()).toEqual(["ordinary-0"]);
  expect(new Set(f.state.sessions.map((session) => session.id)).size).toBe(f.state.sessions.length);
});


test("canonical deleted-project rows can reorder with ordinary siblings before the separate project list arrives", async () => {
  const f = await fixture();
  await f.pagination.load(true);
  const ordinary = f.ordinaryIds();
  const source = ordinary.at(-1)!;
  const neighbor = ordinary.at(-2)!;
  expect(source).toBe("removed-0");
  expect(neighbor).toBe("ordinary-1");
  const row = f.root.querySelector("#session-open-" + source)!.parentElement!;
  row.querySelector(".move-up-action")!.dispatch("click");
  await vi.waitFor(() => {
    const order = f.preferences.loadSessionSidebar("dev").orderedSessionIds;
    expect(order.indexOf(source)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(source) + 1).toBe(order.indexOf(neighbor));
  });
  expect(records.find((record) => record.summary.id === source)!.summary.project?.id).toBe("removed");
});

test("a project page observes external project deletion without discarding other group cursors", async () => {
  const f = await fixture();
  const firstRows = f.visibleIds(f.group("first")!);
  const secondPage = { ...f.pageFor("second") };
  const oldPage = { ...f.pageFor("old") };
  f.deleteProject("first");
  await f.pagination.loadProject("first");
  expect(f.group("first")).toBeNull();
  expect(f.pagination.info().deletedProjectIds).toEqual(["removed", "first"]);
  expect(f.pagination.info().ordinaryTotal).toBe(77);
  expect(f.root.querySelector(".ordinary-conversations-heading")!.textContent).toBe("Conversations (77)");
  for (const id of firstRows) {
    expect(f.visibleIds()).toContain(id);
    expect(f.root.querySelector("#session-open-" + id)!.parentElement!.parentElement).toBe(f.root);
  }
  expect(f.pageFor("second")).toEqual(secondPage);
  expect(f.pageFor("old")).toEqual(oldPage);
  expect(f.visibleIds(f.group("second")!)).toHaveLength(5);
  expect(new Set(f.visibleIds()).size).toBe(f.visibleIds().length);
});


test("late concurrent project metadata cannot resurrect a project already observed as deleted", async () => {
  const f = await fixture();
  const first = deferred(), second = deferred();
  f.client.listSessions.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const firstLoading = f.pagination.loadProject("first");
  const oldFirst = response(f.client.listSessions.mock.calls.at(-1)![1]);
  const secondLoading = f.pagination.loadProject("second");
  f.deleteProject("first");
  second.resolve(f.respond(f.client.listSessions.mock.calls.at(-1)![1]));
  await secondLoading;
  const secondPage = { ...f.pageFor("second") };
  const resetOrdinary = f.ordinaryIds();
  expect(f.group("first")).toBeNull();
  first.resolve(oldFirst);
  await firstLoading;
  expect(f.group("first")).toBeNull();
  expect(f.pagination.info().deletedProjectIds).toEqual(["removed", "first"]);
  expect(f.pagination.info().ordinaryTotal).toBe(77);
  expect(f.pageFor("second")).toEqual(secondPage);
  expect(f.pageFor("second").nextCursor).toBeNull();
  expect(f.ordinaryIds()).toEqual(resetOrdinary);
  expect(f.ordinaryIds()).toHaveLength(20);
  expect(f.visibleIds()).not.toContain("first-24");
});

test.each(["ordinary", "project"])("deletion discovered by a %s response restarts only ordinary paging and reaches every conversation", async (source) => {
  const f = await fixture();
  const secondPage = { ...f.pageFor("second") };
  const oldPage = { ...f.pageFor("old") };
  f.deleteProject("first");
  if (source === "ordinary") await f.pagination.load(true);
  if (source === "project") await f.pagination.loadProject("first");
  expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", expect.objectContaining({
    scope: { kind: "ordinary" }, cursor: null,
  }));
  expect(f.ordinaryIds()).toHaveLength(20);
  expect(f.ordinaryIds()).toEqual(Array.from({ length: 20 }, (_, i) => "first-" + (48 - i)));
  expect(f.pageFor("second")).toEqual(secondPage);
  expect(f.pageFor("old")).toEqual(oldPage);
  expect(f.visibleIds().slice(0, 2)).toEqual(["first-49", "ordinary-29"]);
  for (let page = 0; page < 3; page++) await f.pagination.load(true);
  const excluded = new Set(["first-0", "ordinary-0", "first-49", "ordinary-29"]);
  const expected = records.filter(({ summary }) => !excluded.has(summary.id))
    .filter(({ summary }) => !summary.project || ["first", "removed"].includes(summary.project.id))
    .map(({ summary }) => summary.id).sort();
  expect(f.ordinaryIds().sort()).toEqual(expected);
  expect(f.ordinaryIds()).toHaveLength(77);
  expect(new Set(f.ordinaryIds()).size).toBe(77);
  const calls = f.client.listSessions.mock.calls.length;
  await f.pagination.load(true);
  expect(f.client.listSessions).toHaveBeenCalledTimes(calls);
  expect(f.pageFor("second")).toEqual(secondPage);
});

test("a deletion-triggered ordinary reset invalidates an older pending ordinary continuation", async () => {
  const f = await fixture();
  const pending = deferred();
  f.client.listSessions.mockImplementationOnce(() => pending.promise);
  const oldLoading = f.pagination.load(true);
  const oldResponse = f.respond(f.client.listSessions.mock.calls.at(-1)![1]);
  f.deleteProject("first");
  await f.pagination.loadProject("second");
  expect(f.ordinaryIds()).toHaveLength(20);
  expect(f.ordinaryIds()[0]).toBe("first-48");
  const currentIds = f.state.sessions.map((session) => session.id);
  const currentInfo = JSON.stringify(f.pagination.info());
  pending.resolve(oldResponse);
  await oldLoading;
  expect(f.state.sessions.map((session) => session.id)).toEqual(currentIds);
  expect(JSON.stringify(f.pagination.info())).toBe(currentInfo);
  await f.pagination.load(true);
  expect(f.ordinaryIds()).toHaveLength(40);
  expect(f.pagination.info().ordinaryTotal).toBe(77);
});

test("a failed deletion-triggered reset retries the ordinary first page and preserves project cursors", async () => {
  const f = await fixture();
  const secondPage = { ...f.pageFor("second") };
  f.deleteProject("first");
  f.client.listSessions.mockImplementationOnce(async (_environment, input) => f.respond(input))
    .mockRejectedValueOnce(new Error("ordinary reset unavailable"));
  await f.pagination.loadProject("first");
  expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", expect.objectContaining({
    scope: { kind: "ordinary" }, cursor: null,
  }));
  expect(f.pageFor("second")).toEqual(secondPage);
  const retry = f.root.children.find((item) => item.textContent.includes("retry"))!;
  expect(retry).toBeDefined();
  expect(retry.disabled).toBe(false);
  retry.dispatch("click");
  await vi.waitFor(() => expect(f.ordinaryIds()).toHaveLength(20));
  expect(f.client.listSessions).toHaveBeenLastCalledWith("dev", expect.objectContaining({
    scope: { kind: "ordinary" }, cursor: null,
  }));
  expect(f.ordinaryIds()[0]).toBe("first-48");
  expect(f.pageFor("second")).toEqual(secondPage);
  expect(f.group("first")).toBeNull();
  const resetCalls = f.client.listSessions.mock.calls.filter(([, input]) => input.scope?.kind === "ordinary" && input.cursor === null);
  expect(resetCalls).toHaveLength(2);
});
