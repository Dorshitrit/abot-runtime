import { expect, test } from "vitest";
// @ts-expect-error Browser presentation module has no declaration surface.
import { projectSessionDisplayGroups, sessionProjectId } from "../../web-ui/app/lib/session-project-groups.js";
// @ts-expect-error Browser presentation module has no declaration surface.
import { canReorderSidebarSessions, sessionSidebarGroup } from "../../web-ui/app/lib/session-sidebar-order.js";

const snapshot = Object.freeze({ id: "removed", name: "Project", directory: "/original/work" });
const session = Object.freeze({ id: "conversation", projectId: snapshot.id, project: snapshot });
const ordinary = Object.freeze({ id: "ordinary" });

test("deleted project sessions enter the general list without changing their workdir snapshots", () => {
  const kept = { id: "kept", name: "Kept", directory: "/kept" };
  const inferred = { id: "inferred", project: { ...snapshot, id: "legacy" } };
  const result = projectSessionDisplayGroups([snapshot, kept], [session, ordinary, inferred], [snapshot.id]);
  expect(result.groups.map((group: { id: string }) => group.id)).toEqual(["kept", "legacy"]);
  expect(result.ordinary).toEqual([session, ordinary]);
  expect(result.ordinary[0]).toBe(session);
  expect(session.project).toBe(snapshot);
  expect(session.project.directory).toBe("/original/work");
  expect(sessionProjectId(session)).toBe("removed");
  expect(sessionProjectId(session, ["removed"])).toBeUndefined();
});

test("saved deletion applies to legacy snapshots and future loaded pages without reviving groups", () => {
  const savedDeletion = JSON.parse(JSON.stringify([snapshot.id]));
  expect(projectSessionDisplayGroups([], [{ id: "later", project: snapshot }], savedDeletion))
    .toEqual({ groups: [], ordinary: [{ id: "later", project: snapshot }] });
  expect(projectSessionDisplayGroups([], [session], []).groups).toHaveLength(1);
});

test("deleted project conversations can move among general conversations while pins stay global", () => {
  const deleted = [snapshot.id];
  const active = { id: "active", projectId: "other" };
  expect(sessionSidebarGroup(session, [], deleted)).toBe("ordinary");
  expect(canReorderSidebarSessions(session, ordinary, [], deleted)).toBe(true);
  expect(canReorderSidebarSessions(session, active, [], deleted)).toBe(false);
  expect(canReorderSidebarSessions(session, ordinary, [session.id], deleted)).toBe(false);
  expect(canReorderSidebarSessions(session, active, [session.id, active.id], deleted)).toBe(true);
});

test("creating another project for the same directory does not reattach deleted conversations", () => {
  const recreated = { ...snapshot, id: "new-project" };
  const result = projectSessionDisplayGroups([recreated], [session], [snapshot.id]);
  expect(result.groups).toEqual([{ ...recreated, sessions: [] }]);
  expect(result.ordinary).toEqual([session]);
});

test("large deletion histories preserve grouping order, session identity and current deletions", () => {
  const deletedIds = Array.from({ length: 10_000 }, (_, index) => "deleted-" + index);
  const firstDeleted = { ...snapshot, id: deletedIds[0] };
  const lastDeleted = { ...snapshot, id: deletedIds.at(-1) };
  const kept = Object.freeze({ id: "kept", name: "Kept", directory: "/kept" });
  const empty = Object.freeze({ id: "empty", name: "Empty", directory: "/empty" });
  const first = Object.freeze({ id: "first", projectId: firstDeleted.id, project: kept });
  const last = Object.freeze({ id: "last", project: lastDeleted });
  const active = Object.freeze({ id: "active", projectId: kept.id });
  const inferred = Object.freeze({ id: "inferred", project: { ...snapshot, id: "legacy" } });
  const projects = Object.freeze([firstDeleted, kept, lastDeleted, empty].map(Object.freeze));
  const sessions = Object.freeze([first, active, ordinary, last, inferred]);
  const deleted = Object.freeze([...deletedIds, deletedIds[0]]);
  const before = JSON.stringify({ projects, sessions, deleted });
  const result = projectSessionDisplayGroups(projects, sessions, deleted);

  expect(result.groups).toEqual([
    { ...kept, sessions: [active] }, { ...empty, sessions: [] },
    { ...inferred.project, sessions: [inferred] },
  ]);
  expect(result.ordinary).toEqual([first, ordinary, last]);
  expect(result.groups[0].sessions[0]).toBe(active);
  expect(result.groups[2].sessions[0]).toBe(inferred);
  result.ordinary.forEach((item: object, index: number) => {
    expect(item).toBe([first, ordinary, last][index]);
  });
  expect(JSON.stringify({ projects, sessions, deleted })).toBe(before);

  const next = projectSessionDisplayGroups(projects, sessions, [...deleted, kept.id, "legacy"]);
  expect(next.groups).toEqual([{ ...empty, sessions: [] }]);
  expect(next.ordinary).toEqual(sessions);
  expect(projectSessionDisplayGroups(projects, sessions, []).ordinary).toEqual([ordinary]);
});

test("grouping reads deletion history within a linear budget as conversations grow", () => {
  const ids = Array.from({ length: 1_000 }, (_, index) => "deleted-" + index);
  const project = { id: "active", name: "Active", directory: "/active" };
  let reads = 0;
  const observedIds = new Proxy(ids, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, receiver);
    },
  });
  for (const count of [1, 100, 1_000]) {
    const sessions = Array.from({ length: count }, (_, index) => ({
      id: "session-" + index, projectId: project.id,
    }));
    reads = 0;
    expect(projectSessionDisplayGroups([project], sessions, observedIds).groups[0].sessions)
      .toEqual(sessions);
    // Bound source-list work, without prescribing a particular indexing mechanism.
    expect(reads).toBeLessThanOrEqual(ids.length * 2);
  }
});
