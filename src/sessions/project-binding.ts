import { isAbsolute } from "node:path";
import type { SessionRecord } from "./types.js";

/** Immutable workspace identity captured when a project conversation is created. */
export type SessionProject = Readonly<{
  id: string;
  name: string;
  directory: string;
}>;

export type SessionCreationOptions = Readonly<{ project?: SessionProject }>;

function isSessionProjectRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (!value) return false;
  if (Array.isArray(value)) return false;
  return typeof value === "object";
}

function hasProjectIdentityText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.trim().length > 0;
}

function hasAbsoluteProjectDirectory(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return isAbsolute(value);
}

export function copySessionProject(project: SessionProject): SessionProject {
  if (!isSessionProjectRecord(project))
    throw new TypeError("session_project_invalid");
  if (!hasProjectIdentityText(project.id))
    throw new TypeError("session_project_id_required");
  if (!hasProjectIdentityText(project.name))
    throw new TypeError("session_project_name_required");
  if (!hasAbsoluteProjectDirectory(project.directory))
    throw new TypeError("session_project_directory_absolute_required");
  if (project.directory.includes("\0"))
    throw new TypeError("session_project_directory_invalid");
  return Object.freeze({
    id: project.id,
    name: project.name,
    directory: project.directory,
  });
}

function matchesSavedProjectBinding(
  saved: SessionProject | undefined,
  requested: SessionProject,
): boolean {
  if (!saved) return false;
  if (saved.id !== requested.id) return false;
  return saved.directory === requested.directory;
}

export function assertSessionProjectUnchanged(
  session: SessionRecord,
  requested?: SessionProject,
): void {
  if (!requested) return;
  const project = copySessionProject(requested);
  if (!matchesSavedProjectBinding(session.project, project))
    throw new Error("session_project_binding_immutable");
}
