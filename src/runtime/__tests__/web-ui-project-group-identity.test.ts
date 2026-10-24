import { expect, test, vi } from "vitest";
// @ts-expect-error Browser presentation module has no declarations.
import { projectSessionDisplayGroups, sessionProjectId } from "../../web-ui/app/lib/session-project-groups.js";
// @ts-expect-error Browser presentation module has no declarations.
import { canReorderSidebarSessions, sessionSidebarGroup } from "../../web-ui/app/lib/session-sidebar-order.js";
// @ts-expect-error Browser component has no declarations.
import { renderProjectSessionGroups } from "../../web-ui/app/components/project-session-groups.js";
import { allSidebarElements, SidebarElement } from "./support/session-sidebar-dom.js";

function boundSession(id: string) {
  return { id, projectId: "eval-" + id, project: {
    id: "eval-" + id, name: "Smoke evaluations", directory: "/work/.eval-runs/" + id,
  } };
}

function render(sessions: object[], options: { query?: string; collapsedIds?: string[]; projects?: object[] } = {}) {
  const root = new SidebarElement("div");
  const onNewConversation = vi.fn();
  const onToggleGroup = vi.fn();
  const onToggleProjectSessions = vi.fn();
  renderProjectSessionGroups({
    root, projects: options.projects ?? [], sessions, query: options.query ?? "",
    loading: false, error: "", busyProjectId: "", onNewConversation, onToggleGroup,
    onToggleProjectSessions, onRetry: vi.fn(),
    collapsedProjectIds: new Set(options.collapsedIds ?? []),
    createSessionItem: (session: { id: string }) => {
      const row = new SidebarElement("article");
      row.className = "session-item"; row.dataset.sessionId = session.id;
      return row;
    },
    documentRoot: { createElement: (tag: string) => new SidebarElement(tag) },
  });
  return { root, onNewConversation, onToggleGroup, onToggleProjectSessions };
}

test("session ownership uses actual project fields without interpreting IDs, names or paths", () => {
  const session = boundSession("eval-20261022-a");
  expect(sessionProjectId(session)).toBe(session.projectId);
  expect(sessionProjectId({ id: session.id, projectId: session.projectId })).toBe(session.projectId);
  expect(sessionProjectId({ id: session.id, project: session.project })).toBe(session.projectId);
  expect(sessionProjectId({ ...session, projectId: "user-project" })).toBe("user-project");
  expect(sessionProjectId({ id: "ordinary", title: "Smoke evaluations" })).toBeUndefined();
});

test("registered and inferred projects remain distinct and ordered without mutating their sessions", () => {
  const first = boundSession("first"), second = boundSession("second");
  const ordinary = { id: "ordinary" };
  const userProject = { id: "user", name: first.project.name, directory: first.project.directory };
  const emptyProject = { id: "display:smoke-evaluations", name: "Empty project", directory: "/work/empty" };
  const userSession = { id: "child", projectId: userProject.id };
  const projects = Object.freeze([userProject, first.project, emptyProject].map(Object.freeze));
  const sessions = Object.freeze([first, second, ordinary, userSession].map(Object.freeze));
  const before = JSON.stringify({ projects, sessions });
  const grouped = projectSessionDisplayGroups(projects, sessions);
  expect(grouped.groups.map((group: { id: string }) => group.id))
    .toEqual(["user", "eval-first", "display:smoke-evaluations", "eval-second"]);
  expect(grouped.groups.map((group: { sessions: { id: string }[] }) => group.sessions.map((session) => session.id)))
    .toEqual([["child"], ["first"], [], ["second"]]);
  expect(grouped.groups[1].sessions[0]).toBe(first);
  expect(grouped.groups[3].sessions[0]).toBe(second);
  expect(grouped.ordinary).toEqual([ordinary]);
  expect(grouped.ordinary[0]).toBe(ordinary);
  expect(JSON.stringify({ projects, sessions })).toBe(before);
});

test("every real project keeps its own conversation action, including empty registered projects", () => {
  const first = boundSession("first"), second = boundSession("second");
  const emptyProject = { id: "empty", name: "Empty", directory: "/work/empty" };
  const f = render([first, second], { projects: [first.project, emptyProject] });
  const sections = f.root.children.filter((node) => node.className === "project-session-group");
  expect(sections).toHaveLength(3);
  expect(sections.map((section) => section.querySelector(".project-group-content")!.id))
    .toEqual(["project-sessions-eval-first", "project-sessions-empty", "project-sessions-eval-second"]);
  for (const section of sections) section.querySelector(".project-group-new")!.dispatch("click");
  expect(f.onNewConversation.mock.calls).toEqual([["eval-first"], ["empty"], ["eval-second"]]);
  expect(sections[1]!.querySelector(".project-empty-copy")!.textContent).toBe("No conversations yet");
});

test("preview, expansion and search retain the actual project disclosure identity", () => {
  const first = boundSession("run-0");
  const sessions = Array.from({ length: 7 }, (_, index) => ({ ...first, id: "run-" + index }));
  const f = render(sessions);
  const rows = f.root.querySelector(".project-session-rows")!.children;
  expect(rows.filter((row) => !row.hidden)).toHaveLength(5);
  f.root.querySelector(".project-session-more")!.dispatch("click");
  expect(rows.filter((row) => !row.hidden)).toHaveLength(7);
  expect(f.onToggleProjectSessions).toHaveBeenCalledWith(first.projectId, true);
  const collapsed = render(sessions, { collapsedIds: [first.projectId] });
  expect(collapsed.root.querySelector(".project-group-content")!.hidden).toBe(true);
  collapsed.root.querySelector(".project-group-toggle")!.dispatch("click");
  expect(collapsed.onToggleGroup).toHaveBeenCalledWith(first.projectId, false);
  // The session controller owns query filtering; the group receives its matching rows.
  const search = render([sessions[6]!], { query: "run-6", collapsedIds: [first.projectId] });
  expect(search.root.querySelector(".project-group-content")!.hidden).toBe(false);
  expect(search.root.querySelector(".project-session-more")).toBeNull();
  expect(allSidebarElements(search.root).filter((node) => node.dataset.sessionId).map((node) => node.dataset.sessionId))
    .toEqual(["run-6"]);
});

test("reordering respects actual project boundaries while pins remain global", () => {
  const first = boundSession("first"), second = boundSession("second");
  const sibling = { id: "sibling", projectId: first.projectId };
  expect(sessionSidebarGroup(first, [])).toBe("project:eval-first");
  expect(sessionSidebarGroup(second, [])).toBe("project:eval-second");
  expect(canReorderSidebarSessions(first, second, [])).toBe(false);
  expect(canReorderSidebarSessions(first, sibling, [])).toBe(true);
  expect(canReorderSidebarSessions(first, { id: "ordinary" }, [])).toBe(false);
  expect(canReorderSidebarSessions(first, sibling, ["first"])).toBe(false);
  expect(sessionSidebarGroup(first, ["first"])).toBe("pinned");
  expect(canReorderSidebarSessions(first, second, ["first", "second"])).toBe(true);
});
