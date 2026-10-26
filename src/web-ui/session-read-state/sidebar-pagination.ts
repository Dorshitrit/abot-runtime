import { createHash } from "node:crypto";
import type { SessionMetadata } from "../../sessions/metadata/projection.js";
import type { SessionProject } from "../../sessions/project-binding.js";
import type { RuntimeProjectCatalog } from "../../runtime/projects/contracts.js";
import { sessionMetadataPage, type SessionPageQuery } from "./pagination.js";

export type SidebarSessionScope = { kind: "ordinary" } | { kind: "project"; projectId: string };
export type SidebarSessionPageQuery = SessionPageQuery & { sidebar?: boolean; scope?: SidebarSessionScope };
const projectPreviewLimit = 5;

function readSidebarScope(value: unknown): SidebarSessionScope | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("session_sidebar_scope_invalid");
  const scope = value as Partial<SidebarSessionScope>;
  if (scope.kind === "ordinary") return { kind: "ordinary" };
  if (scope.kind !== "project") throw new Error("session_sidebar_scope_invalid");
  if (typeof scope.projectId !== "string" || !scope.projectId.trim()) throw new Error("session_sidebar_scope_invalid");
  return { kind: "project", projectId: scope.projectId };
}

function sidebarSessionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

function sidebarCursorIdentity(scope: SidebarSessionScope, input: SidebarSessionPageQuery) {
  return createHash("sha256").update(JSON.stringify({
    scope, query: typeof input.query === "string" ? input.query.trim().toLowerCase() : "", archived: input.archived === true,
    pinned: sidebarSessionIds(input.pinnedSessionIds), ordered: sidebarSessionIds(input.orderedSessionIds),
    archivedIds: sidebarSessionIds(input.archivedSessionIds).sort(),
  })).digest("base64url");
}

function readSidebarCursor(cursor: string | null | undefined, identity: string): string | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (value?.scope !== identity) throw new Error();
    if (typeof value.cursor !== "string") throw new Error();
    return value.cursor;
  } catch { throw new Error("session_cursor_invalid"); }
}

function writeSidebarCursor(cursor: string | null, identity: string): string | null {
  if (!cursor) return null;
  return Buffer.from(JSON.stringify({ scope: identity, cursor })).toString("base64url");
}

function shouldAddHistoricalProject(project: SessionProject | undefined, deleted: Set<string>, projects: Map<string, SessionProject>): project is SessionProject {
  if (!project) return false;
  if (deleted.has(project.id)) return false;
  return !projects.has(project.id);
}

function sidebarProjects(records: SessionMetadata[], catalog: RuntimeProjectCatalog): SessionProject[] {
  const deleted = new Set(catalog.deletedProjectIds);
  const projects = new Map<string, SessionProject>(catalog.projects
    .filter((project) => !deleted.has(project.id)).map((project) => [project.id, project]));
  for (const { summary } of records) {
    const project = summary.project;
    if (!shouldAddHistoricalProject(project, deleted, projects)) continue;
    projects.set(project.id, project);
  }
  return [...projects.values()];
}

function hasSeparatePinnedPlacement(input: SidebarSessionPageQuery, id: string, pinned: Set<string>): boolean {
  if (input.archived === true) return false;
  return pinned.has(id);
}

function isOrdinarySidebarRecord(record: SessionMetadata, deleted: Set<string>): boolean {
  const project = record.summary.project;
  if (!project) return true;
  return deleted.has(project.id);
}

function belongsToSidebarProject(record: SessionMetadata, projectId: string, deleted: Set<string>): boolean {
  if (deleted.has(projectId)) return false;
  return record.summary.project?.id === projectId;
}

function sidebarGroupPage(records: SessionMetadata[], input: SidebarSessionPageQuery, scope: SidebarSessionScope,
  limit: number, cursor?: string | null) {
  const identity = sidebarCursorIdentity(scope, input);
  const page = sessionMetadataPage(records, { ...input, cursor: readSidebarCursor(cursor, identity) }, limit);
  return { records: page.records, total: page.total, nextCursor: writeSidebarCursor(page.nextCursor, identity) };
}

/** One independent window per group; immutable session workspace bindings are never rewritten. */
export function sidebarMetadataPage(records: SessionMetadata[], input: SidebarSessionPageQuery,
  limit: number, catalog: RuntimeProjectCatalog) {
  const scope = readSidebarScope(input.scope);
  if (!scope && input.cursor) throw new Error("session_sidebar_scope_required");
  const filtered = sessionMetadataPage(records, { ...input, cursor: null }, Math.max(1, records.length));
  const projects = sidebarProjects(records, catalog);
  const deleted = new Set(catalog.deletedProjectIds);
  const pinnedIds = new Set(sidebarSessionIds(input.pinnedSessionIds));
  const pinned = filtered.records.filter(({ summary }) => hasSeparatePinnedPlacement(input, summary.id, pinnedIds));
  const grouped = filtered.records.filter(({ summary }) => !hasSeparatePinnedPlacement(input, summary.id, pinnedIds));
  const ordinary = grouped.filter((record) => isOrdinarySidebarRecord(record, deleted));
  const metadata = { total: filtered.total, archivedCount: filtered.archivedCount, ordinaryTotal: ordinary.length,
    projects, deletedProjectIds: [...catalog.deletedProjectIds] };

  if (scope?.kind === "ordinary") {
    const page = sidebarGroupPage(ordinary, input, scope, limit, input.cursor);
    return { ...metadata, records: page.records, nextCursor: page.nextCursor, projectPages: [] };
  }
  if (scope?.kind === "project") {
    const selected = grouped.filter((record) => belongsToSidebarProject(record, scope.projectId, deleted));
    const page = sidebarGroupPage(selected, input, scope, limit, input.cursor);
    return { ...metadata, records: page.records, nextCursor: null,
      projectPages: [{ projectId: scope.projectId, total: page.total, nextCursor: page.nextCursor }] };
  }
  const ordinaryPage = sidebarGroupPage(ordinary, input, { kind: "ordinary" }, limit);
  const projectWindows = projects.map((project) => {
    const selected = grouped.filter((record) => belongsToSidebarProject(record, project.id, deleted));
    const page = sidebarGroupPage(selected, input, { kind: "project", projectId: project.id }, projectPreviewLimit);
    return { projectId: project.id, ...page };
  });
  const selectedSessionIds = new Set([
    ...pinned, ...projectWindows.flatMap((page) => page.records), ...ordinaryPage.records,
  ].map(({ summary }) => summary.id));
  const isSelectedSidebarRecord = ({ summary }: SessionMetadata) => selectedSessionIds.has(summary.id);
  return { ...metadata, records: filtered.records.filter(isSelectedSidebarRecord),
    nextCursor: ordinaryPage.nextCursor,
    projectPages: projectWindows.map(({ projectId, total, nextCursor }) => ({ projectId, total, nextCursor })) };
}
