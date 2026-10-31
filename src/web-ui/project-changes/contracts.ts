export type ProjectChangeStatus = "added" | "modified" | "deleted" | "untracked" | "conflicted" | "type_changed";
export type ProjectChangeFile = {
  id: string;
  path: string;
  status: ProjectChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};
export type ProjectChanges = {
  status: "available" | "no_project" | "not_git" | "git_unavailable" | "unavailable";
  files: ProjectChangeFile[];
  totalFiles: number;
  additions: number | null;
  deletions: number | null;
  truncated: boolean;
  base: "head" | "empty" | null;
  revision: string | null;
  message?: string;
};
export type ProjectChangePreview = {
  id: string;
  path: string;
  status: "text" | "binary" | "too_large" | "unavailable";
  patch: string | null;
  message?: string;
};
export type RecordedProjectChange = {
  status: "available" | "unchanged" | "unavailable";
  file: ProjectChangeFile | null;
  preview: ProjectChangePreview | null;
  base: "head" | "empty" | null;
  revision: string | null;
  message?: string;
};
export class ProjectChangesError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ProjectChangesError";
  }
}
export const PROJECT_CHANGE_LIMIT = 200;
export const PROJECT_IDENTITY_BYTES = 4 * 1024 * 1024;
export const PROJECT_FILE_BYTES = 256 * 1024;
export const PROJECT_GIT_BYTES = 2 * 1024 * 1024;
export function unavailableProjectChanges(status: Exclude<ProjectChanges["status"], "available">, message: string): ProjectChanges {
  return { status, files: [], totalFiles: 0, additions: null, deletions: null, truncated: false, base: null, revision: null, message };
}
