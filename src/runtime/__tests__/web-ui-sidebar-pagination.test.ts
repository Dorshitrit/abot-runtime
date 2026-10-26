import type { ServerResponse } from "node:http";
import { expect, test, vi } from "vitest";
import * as sessionMetadataStore from "../../sessions/metadata/store.js";
import { projectSessionMetadata } from "../../sessions/metadata/projection.js";
import { sidebarMetadataPage, type SidebarSessionPageQuery } from "../../web-ui/session-read-state/sidebar-pagination.js";
import { sessionMetadataPage } from "../../web-ui/session-read-state/pagination.js";
import { WebSessionRoutes } from "../../web-ui/local-runtime/session-routes.js";
import { WebSessionReadStates } from "../../web-ui/session-read-state/service.js";
import type { RuntimeEnvironment } from "../../web-ui/local-runtime/contracts.js";
import type { RuntimeProjectCatalog } from "../projects/contracts.js";

const project = (id: string) => ({ id, name: id, directory: `/projects/${id}`, createdAt: new Date(0).toISOString() });
const catalog: RuntimeProjectCatalog = { projects: [project("alpha"), project("beta"), project("empty")], deletedProjectIds: ["deleted"] };
function records(prefix: string, count: number, projectId?: string) {
  return Array.from({ length: count }, (_, index) => projectSessionMetadata({
    id: `${prefix}-${index}`, title: `${prefix} chat ${index}`, createdAt: new Date(index).toISOString(), updatedAt: new Date(index).toISOString(),
    ...(projectId ? { project: project(projectId) } : {}), lastAgentMode: "reasoning", messageCount: 0, messages: [],
  }, "test"));
}
const all = [...records("alpha", 45, "alpha"), ...records("beta", 2, "beta"), ...records("historical", 4, "historical"),
  ...records("deleted", 3, "deleted"), ...records("ordinary", 30)];
const query: SidebarSessionPageQuery = { sidebar: true, pinnedSessionIds: ["alpha-44", "ordinary-29"], archivedSessionIds: ["alpha-0", "ordinary-0"] };
const ids = (page: ReturnType<typeof sidebarMetadataPage>) => page.records.map(({ summary }) => summary.id);
const initial = () => sidebarMetadataPage(all, query, 20, catalog);

test("all project groups have independent previews and cannot consume the ordinary first page", () => {
  const page = initial();
  expect(page.total).toBe(82);
  expect(page.archivedCount).toBe(2);
  expect(page.ordinaryTotal).toBe(31);
  expect(page.projects.map(({ id }) => id)).toEqual(["alpha", "beta", "empty", "historical"]);
  expect(page.projectPages.map(({ projectId, total }) => [projectId, total])).toEqual([
    ["alpha", 43], ["beta", 2], ["empty", 0], ["historical", 4],
  ]);
  expect(ids(page).slice(0, 2)).toEqual(["alpha-44", "ordinary-29"]);
  expect(ids(page).filter((id) => id.startsWith("alpha-")).length).toBe(6);
  expect(page.records.filter(({ summary }) => !summary.project).length).toBe(21);
  expect(new Set(ids(page)).size).toBe(page.records.length);
  expect(page.nextCursor).toBeTruthy();
  expect(page.projectPages.find(({ projectId }) => projectId === "empty")).toMatchObject({ total: 0, nextCursor: null });
});

test("each continuation returns only its group and reaches the complete disjoint set", () => {
  const first = initial();
  const ordinary = sidebarMetadataPage(all, { ...query, scope: { kind: "ordinary" }, cursor: first.nextCursor }, 20, catalog);
  expect(ordinary.records).toHaveLength(11);
  expect(ordinary.nextCursor).toBeNull();
  expect(ordinary.projectPages).toEqual([]);
  expect(ordinary.records.every(({ summary }) => !summary.project || summary.project.id === "deleted")).toBe(true);
  const alphaPage = first.projectPages.find(({ projectId }) => projectId === "alpha")!;
  const second = sidebarMetadataPage(all, { ...query, scope: { kind: "project", projectId: "alpha" }, cursor: alphaPage.nextCursor }, 20, catalog);
  const third = sidebarMetadataPage(all, { ...query, scope: { kind: "project", projectId: "alpha" }, cursor: second.projectPages[0]!.nextCursor }, 20, catalog);
  expect([second.records.length, third.records.length]).toEqual([20, 18]);
  expect(second.records.every(({ summary }) => summary.project?.id === "alpha")).toBe(true);
  expect(second.projectPages.map(({ projectId }) => projectId)).toEqual(["alpha"]);
  expect(third.projectPages[0]!.nextCursor).toBeNull();
  const combined = [...ids(first), ...ids(ordinary), ...ids(second), ...ids(third)];
  expect(combined).toHaveLength(82);
  expect(new Set(combined).size).toBe(82);
});

test("deleted projects join ordinary pages and keep their immutable workspace binding", () => {
  const page = sidebarMetadataPage(records("deleted", 2, "deleted"), { sidebar: true }, 20, catalog);
  expect(page.ordinaryTotal).toBe(2);
  expect(page.projects.some(({ id }) => id === "deleted")).toBe(false);
  expect(page.records.every(({ summary }) => summary.project?.id === "deleted")).toBe(true);
  expect(page.deletedProjectIds).toEqual(["deleted"]);
});

test("archived pins participate in their own groups, and search preserves every project descriptor", () => {
  const page = sidebarMetadataPage(all, { ...query, archived: true, pinnedSessionIds: ["alpha-0", "ordinary-0"] }, 20, catalog);
  expect(page.ordinaryTotal).toBe(1);
  expect(page.projectPages.find(({ projectId }) => projectId === "alpha")?.total).toBe(1);
  expect(ids(page)).toEqual(["alpha-0", "ordinary-0"]);
  const search = sidebarMetadataPage(all, { ...query, query: "beta chat 1" }, 20, catalog);
  expect(ids(search)).toEqual(["beta-1"]);
  expect(search.ordinaryTotal).toBe(0);
  expect(search.projects.map(({ id }) => id)).toEqual(["alpha", "beta", "empty", "historical"]);
});

test("sidebar cursors reject reuse for another group, search or preferences", () => {
  const cursor = initial().nextCursor;
  const base = { ...query, cursor, scope: { kind: "ordinary" } as const };
  expect(() => sidebarMetadataPage(all, { ...query, cursor }, 20, catalog)).toThrow("session_sidebar_scope_required");
  for (const update of [
    { scope: { kind: "project" as const, projectId: "alpha" } }, { query: "changed" }, { archived: true },
    { pinnedSessionIds: [] }, { orderedSessionIds: ["ordinary-2"] }, { archivedSessionIds: [] },
  ]) expect(() => sidebarMetadataPage(all, { ...base, ...update }, 20, catalog)).toThrow("session_cursor_invalid");
  expect(() => sidebarMetadataPage(all, { ...base, cursor: "invalid" }, 20, catalog)).toThrow("session_cursor_invalid");
});

test("legacy global pagination remains bounded without the sidebar contract", () => {
  const legacy = sessionMetadataPage(all, query, 20);
  expect(legacy.records).toHaveLength(20);
  expect(legacy.total).toBe(82);
  expect(legacy).not.toHaveProperty("projectPages");
});

test("only sidebar requests fetch the canonical project catalog before listing", async () => {
  const list = vi.fn(async () => ({ sessions: [] }));
  const loadCatalog = vi.fn(async () => catalog);
  const routes = new WebSessionRoutes({ list } as unknown as WebSessionReadStates);
  const environment = { services: { projects: { catalog: loadCatalog } } } as unknown as RuntimeEnvironment;
  const response = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
  const request = { method: "POST", segments: ["chat", "sessions", "page"], environmentId: "dev", environment, response };
  await routes.handle({ ...request, body: {} });
  expect(loadCatalog).not.toHaveBeenCalled();
  expect(list).toHaveBeenLastCalledWith("dev", {}, undefined);
  await routes.handle({ ...request, body: { sidebar: true, deletedProjectIds: [] } });
  expect(loadCatalog).toHaveBeenCalledOnce();
  expect(list).toHaveBeenLastCalledWith("dev", { sidebar: true, deletedProjectIds: [] }, catalog);
  loadCatalog.mockRejectedValueOnce(new Error("registry unavailable"));
  await expect(routes.handle({ ...request, body: { sidebar: true } })).rejects.toThrow("registry unavailable");
  expect(list).toHaveBeenCalledTimes(2);
  await expect(routes.handle({ ...request, environment: { services: {} } as RuntimeEnvironment, body: { sidebar: true } })).rejects.toThrow("projects_unavailable");
});

test("the read-state service rejects sidebar requests without a canonical catalog", async () => {
  const metadata = vi.spyOn(sessionMetadataStore, "listSessionMetadata").mockResolvedValueOnce([]);
  const environment = { services: { config: { paths: { sessionsDir: "/unused/sessions" } }, sessions: {} } } as RuntimeEnvironment;
  try {
    const reads = new WebSessionReadStates(() => environment);
    await expect(reads.list("dev", { sidebar: true })).rejects.toThrow("projects_unavailable");
  } finally { metadata.mockRestore(); }
});

test("an unrelated project deletion does not invalidate independent continuation cursors", () => {
  const first = initial();
  const changed = { projects: catalog.projects.filter(({ id }) => id !== "beta"), deletedProjectIds: [...catalog.deletedProjectIds, "beta"] };
  const alphaCursor = first.projectPages.find(({ projectId }) => projectId === "alpha")!.nextCursor;
  const alpha = sidebarMetadataPage(all, { ...query, scope: { kind: "project", projectId: "alpha" }, cursor: alphaCursor }, 20, changed);
  expect(alpha.records).toHaveLength(20);
  expect(alpha.records.every(({ summary }) => summary.project?.id === "alpha")).toBe(true);
  expect(ids(alpha).some((id) => ids(first).includes(id))).toBe(false);
  const ordinary = sidebarMetadataPage(all, { ...query, scope: { kind: "ordinary" }, cursor: first.nextCursor }, 20, changed);
  expect(ordinary.ordinaryTotal).toBe(33);
  expect(ordinary.records).toHaveLength(13);
  expect(ordinary.nextCursor).toBeNull();
  expect(ordinary.records.every(({ summary }) => !summary.project || ["deleted", "beta"].includes(summary.project.id))).toBe(true);
});

test("a deleted target project continuation is empty and cannot resurrect its project binding", () => {
  const cursor = initial().projectPages.find(({ projectId }) => projectId === "alpha")!.nextCursor;
  const changed = { projects: catalog.projects.filter(({ id }) => id !== "alpha"), deletedProjectIds: [...catalog.deletedProjectIds, "alpha"] };
  const page = sidebarMetadataPage(all, { ...query, scope: { kind: "project", projectId: "alpha" }, cursor }, 20, changed);
  expect(page.records).toEqual([]);
  expect(page.projectPages).toEqual([{ projectId: "alpha", total: 0, nextCursor: null }]);
  expect(page.projects.some(({ id }) => id === "alpha")).toBe(false);
  expect(page.deletedProjectIds).toContain("alpha");
  expect(all[0]!.summary.project?.id).toBe("alpha");
});

test("initial independent windows preserve the newest ordinary conversation as the global fallback", () => {
  const candidates = [...records("old-project", 4, "alpha"), ...records("ordinary", 10)];
  const page = sidebarMetadataPage(candidates, { sidebar: true }, 2, catalog);
  expect(ids(page)).toEqual(["ordinary-9", "ordinary-8", "old-project-3", "old-project-2", "old-project-1", "old-project-0"]);
  expect(page.records[0]!.summary.id).toBe(sessionMetadataPage(candidates, {}, 1).records[0]!.summary.id);
  expect(page.ordinaryTotal).toBe(10);
  expect(page.nextCursor).toBeTruthy();
  expect(page.projectPages.find(({ projectId }) => projectId === "alpha")?.total).toBe(4);
});

test("initial independent windows preserve legacy pin priority and manual order across groups", () => {
  const candidates = [...records("project", 3, "alpha"), ...records("ordinary", 3)];
  const input = { sidebar: true, pinnedSessionIds: ["project-0", "ordinary-0"],
    orderedSessionIds: ["ordinary-1", "project-2", "ordinary-2", "project-1", "ordinary-0", "project-0"] };
  const page = sidebarMetadataPage(candidates, input, 20, catalog);
  expect(ids(page)).toEqual(["project-0", "ordinary-0", "ordinary-1", "project-2", "ordinary-2", "project-1"]);
  expect(ids(page)).toEqual(sessionMetadataPage(candidates, input, candidates.length).records.map(({ summary }) => summary.id));
  expect(page.ordinaryTotal).toBe(2);
  expect(page.projectPages.find(({ projectId }) => projectId === "alpha")?.total).toBe(2);
});
