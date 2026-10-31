export type ProjectChangeFile = {
  id: string; path: string;
  status: "added" | "modified" | "deleted" | "untracked" | "conflicted" | "type_changed";
  additions: number | null; deletions: number | null; binary: boolean;
};
export type ProjectChanges = {
  status: "available" | "no_project" | "not_git" | "git_unavailable" | "unavailable";
  revision: string | null; files: ProjectChangeFile[]; totalFiles: number;
  additions: number | null; deletions: number | null; truncated: boolean;
  base: "head" | "empty" | null; message?: string;
};
export type ProjectChangeDiff = {
  id: string; path: string; status: "text" | "binary" | "too_large" | "unavailable";
  patch: string | null; message?: string;
};
export type ProjectOperationChanges = {
  status: "available" | "unchanged" | "unavailable"; file: ProjectChangeFile | null;
  preview: ProjectChangeDiff | null; base: "head" | "empty" | null; revision: string | null; message?: string;
};
export type ProjectChangesRequest = { environmentId: string; sessionId: string; signal?: AbortSignal };
export type ProjectChangesClient = {
  supportsProjectChanges(): boolean;
  loadProjectOperationChanges(input: ProjectChangesRequest & { requestId: string; executionId: string }): Promise<{ ok: true; change: ProjectOperationChanges }>;
  loadProjectChanges(input: ProjectChangesRequest): Promise<{ ok: true; changes: ProjectChanges }>;
  loadProjectChangeDiff(input: ProjectChangesRequest & { revision: string; fileId: string }): Promise<{ ok: true; file: ProjectChangeDiff }>;
};
export declare function createProjectChangesRequests(options: {
  requestApi(path: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  getConfig(): Record<string, unknown>;
}): ProjectChangesClient;
