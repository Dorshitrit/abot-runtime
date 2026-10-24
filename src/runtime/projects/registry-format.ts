import { copySessionProject } from "../../sessions/project-binding.js";
import type { RuntimeProject, RuntimeProjectCatalog } from "./contracts.js";

function isCatalogRecord(value: unknown): value is Record<string, unknown> {
  if (!value) return false;
  if (Array.isArray(value)) return false;
  return typeof value === "object";
}

function hasCatalogFields(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) =>
    ["version", "projects", "deletedProjectIds"].includes(key),
  );
}

function hasDeletedProjectIds(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  if (!value.every((id) => typeof id === "string" && id.trim().length > 0))
    return false;
  return new Set(value).size === value.length;
}

function readProjects(input: unknown[]): RuntimeProject[] {
  const projects = input.map((entry) => {
    const record = entry as RuntimeProject;
    const project = copySessionProject(record);
    if (typeof record.createdAt !== "string")
      throw new Error("project_registry_created_at_invalid");
    return { ...project, createdAt: record.createdAt };
  });
  if (new Set(projects.map((project) => project.id)).size !== projects.length)
    throw new Error("project_registry_duplicate_id");
  return projects;
}

/** Legacy arrays have no removals; versioned catalogs retain explicit deletions. */
export function readProjectCatalog(input: unknown): RuntimeProjectCatalog {
  if (Array.isArray(input))
    return { projects: readProjects(input), deletedProjectIds: [] };
  if (!isCatalogRecord(input)) throw new Error("project_registry_invalid");
  if (input.version !== 1) throw new Error("project_registry_version_invalid");
  if (!hasCatalogFields(input)) throw new Error("project_registry_fields_invalid");
  if (!Array.isArray(input.projects)) throw new Error("project_registry_projects_invalid");
  if (!hasDeletedProjectIds(input.deletedProjectIds))
    throw new Error("project_registry_deleted_ids_invalid");
  const projects = readProjects(input.projects);
  const deleted = new Set(input.deletedProjectIds);
  if (projects.some((project) => deleted.has(project.id)))
    throw new Error("project_registry_active_deleted_conflict");
  return { projects, deletedProjectIds: [...input.deletedProjectIds] };
}
